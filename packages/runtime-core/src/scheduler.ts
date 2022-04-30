import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

// 有正处于 刷新中 的队列
let isFlushing = false
// 有出于 待刷新 的队列
let isFlushPending = false

// 渲染任务队列
const queue: SchedulerJob[] = []
// 渲染任务队列中正在执行的任务的索引
let flushIndex = 0

// 需要在渲染任务之前执行的任务队列
const pendingPreFlushCbs: SchedulerJob[] = []
// 配套的正在执行的任务队列
let activePreFlushCbs: SchedulerJob[] | null = null
// 索引
let preFlushIndex = 0

// 需要在渲染任务之后执行的任务队列
const pendingPostFlushCbs: SchedulerJob[] = []
// 配套的队列和索引
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

// 异步更新的本质：Promise
const resolvedPromise: Promise<any> = Promise.resolve()
// 当前正在执行的 Promise 实例
let currentFlushPromise: Promise<void> | null = null

let currentPreFlushParentJob: SchedulerJob | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

/**
 * 等待 DOM 更新完成执行回调函数或配合 await 执行 nextTick 后面的程序。
 * 其本质是 Promise.then，即在浏览器的 微任务 队列放一个方法（该方法在渲染任务之后）。
 * 更改响应式状态 -> 组件渲染任务入队 -> 刷新队列的任务进入 浏览器微任务队列 -> 执行到 nextTick，nextTick 任务或后续程序进入浏览器微任务队列
 */
export function nextTick<T = void>(
  this: T,
  fn?: (this: T) => void
): Promise<void> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

/**
 * 由于 queue 中的 job 是按照 job.id 增序排列，
 * 所以使用二分查找（提高查找效率）找到 job 在 queue 中的合适位置，
 * 这样可以保证 job 不被跳过，也可以避免被重复执行
 * @param id 待搜索的 job id
 * @returns 返回 job 插入的合适位置
 */
// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(id: number) {
  // 起始索引是队列中正在刷新任务的索引 + 1
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  // 结束索引
  let end = queue.length

  // 因为 queue 中的 job 是按照 job.id 由小到大的进行排序的，所以这里采用二分法已提高查找效率
  while (start < end) {
    // 找到 start 和 end 之间的中间索引，这里通过位运算进行计算，右移一位相当于除以 2
    const middle = (start + end) >>> 1
    // 获取指定索引位置任务的 id
    const middleJobId = getId(queue[middle])
    // 根据 middleJobId 和 搜索任务 id 的大小比较，更改 start 和 end 索引
    middleJobId < id ? (start = middle + 1) : (end = middle)
  }

  return start
}

/**
 * 任务队列 
 * @param job 任务
 */
export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  // (队列为空 || 队列中不含有该 job) && job !== currentPreFlushParentJob
  if (
    (!queue.length ||
      !queue.includes(
        // 搜索的任务
        job,
        // 搜索的开始索引 = 是否已经在刷新了 && 任务允许递归 ? flushIndex + 1 : flushIndex
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    job !== currentPreFlushParentJob
  ) {
    if (job.id == null) {
      // 任务没有 id，则直接放到队尾
      queue.push(job)
    } else {
      // 将 job 按照 job.id 插入到 queue 中合适的位置
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    // 刷新队列
    queueFlush()
  }
}

/**
 * 刷新队列，其本质就是就在浏览器的微任务队列放一个刷新队列的任务。
 * 如果目前没有处于正在刷新和待刷新状态的队列，则在浏览器的微任务队列放一个刷新队列的任务，
 * 并将 isFlushPending 置为 true，表示目前已有待刷新的队列了
 */
function queueFlush() {
  // 如果没有处于正在刷新状态 和 待刷新状态的 队列，则在浏览器的微任务队列放一个刷新队列的任务
  if (!isFlushing && !isFlushPending) {
    // 标识有待刷新的队列
    isFlushPending = true
    // 将刷新队列的任务放到浏览器的微任务队列中
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

/**
 * 将任务放到任务队列，然后 刷新队列
 * @param cb 任务
 * @param activeQueue 正在执行任务的队列
 * @param pendingQueue 存放任务的 队列
 * @param index 当前正在执行的任务的索引
 */
function queueCb(
  cb: SchedulerJobs,
  activeQueue: SchedulerJob[] | null,
  pendingQueue: SchedulerJob[],
  index: number
) {
  // 将任务放入队列
  if (!isArray(cb)) {
    if (
      !activeQueue ||
      !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)
    ) {
      pendingQueue.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingQueue.push(...cb)
  }
  // 刷新队列
  queueFlush()
}

// 向 pendingPreFlushCbs 队列中添加任务
export function queuePreFlushCb(cb: SchedulerJob) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}

// 向 pendingPostFlushCbs 队列中添加任务
export function queuePostFlushCb(cb: SchedulerJobs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

/**
 * 刷新 pendingPreFlushCbs 队列，即依次执行队列中的每个任务。
 * 队列中存放着所有需要在 渲染任务 之前执行的任务，比如 options.flush = pre 的 watcher
 * @param seen 
 * @param parentJob 
 */
export function flushPreFlushCbs(
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  // 如果队列不为空
  if (pendingPreFlushCbs.length) {
    currentPreFlushParentJob = parentJob
    // 队列任务去重，并将所有任务都放到 activePreFlushCbs 数组中
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)]
    // 清空源队列（原始数据）
    pendingPreFlushCbs.length = 0
    if (__DEV__) {
      seen = seen || new Map()
    }
    // 遍历任务数组，依次执行其中的每个任务
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }
      activePreFlushCbs[preFlushIndex]()
    }
    // 重置相关变量：执行的任务数组、索引
    activePreFlushCbs = null
    preFlushIndex = 0
    currentPreFlushParentJob = null
    // 递归调用 flushPreFlushCbs，目的是为了执行在上述任务执行期间产生的新的任务
    // recursively flush until it drains
    flushPreFlushCbs(seen, parentJob)
  }
}

/**
 * 刷新 pendingPostFlushCbs 队列，即依次执行队列中的每个任务。
 * 队列中存放着所有需要在 渲染任务 之后执行的任务，比如 options.flush = post 的 watcher
 */
export function flushPostFlushCbs(seen?: CountMap) {
  // pendingPostFLushCbs 不为空
  if (pendingPostFlushCbs.length) {
    // 队列中任务去重，将去重后的任务放到 deduped 数组
    const deduped = [...new Set(pendingPostFlushCbs)]
    // 清空原始队列
    pendingPostFlushCbs.length = 0

    // 如果已经有处于激活状态的 队列，则将这些任务都放到 activePostFlushCbs 队列末尾
    // #1947 already has active queue, nested flushPostFlushCbs call
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    // 没有已经激活的队列时，会走到这里，将待执行的任务放到队列中
    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 队列排序
    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    // 遍历队列，依次执行队列中的每个任务
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    // 任务执行完了，就清空队列
    activePostFlushCbs = null
    // 重置队列中的任务索引
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

/**
 * 刷新任务，负责刷新队列，即执行队列中的任务方法 
 * 1. 状态更改，将 待刷新 改为 正在刷新
 * 2. 执行需要在 渲染任务 前执行的任务，比如 options.flush 为 pre 的用户 watcher（getter 和 回调）
 * 3. 按照 job.id 由小到大的顺序排序队列
 * 4. 遍历队列，依次执行队列中的每个任务
 *    4.1. 任务执行期间可能会触发其它任务入队，比如 watcher 回调中更改了某个响应式状态，所以新任务入队时需要插入到队列的正确位置，保证队列中剩余任务依旧有序
 * 5. 重置相关变量
 *    5.1. flushIndex = 0，队列中正在执行的任务的索引
 *    5.2. queue.length = 0，清空队列
 * 6. 执行需要在 渲染任务 后执行的任务，比如 options.flush 为 post 的用户 watcher（getter、回调）
 * 7. 重置相关变量
 *    7.1. isFlushing = false，标识没有正在刷新的队列
 *    7.2. currentFlushPromise = null 微任务的 Promise 实例
 * 8. 重新检查三大队列，如果任何队列中有了新的任务（刚才执行的任务可能会触发新任务入队）递归调用 flushJob
 */
function flushJobs(seen?: CountMap) {
  // 将待刷新状态置为 false
  isFlushPending = false
  // 标识有正处于刷新状态的队列，即将 待刷新 改为 正在刷新
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // 刷新 pendingPreFlushCbs 队列，即依次执行队列中的每个任务。
  // 队列中存放着所有需要在 渲染任务 之前执行的任务，比如 options.flush = pre 的 watcher
  flushPreFlushCbs(seen)

  // 在刷新队列之前先对队列进行排序，job.id 由小到大，这么做的好处是：
  // 1. 组件更新是从父组件到子组件（父组件先于子组件创建，所以它的渲染副作用具有更小的优先级编号）
  // 2. 如果子组件在父组件更新期间被卸载了，那就可以跳过子组件的更新了。
  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  queue.sort((a, b) => getId(a) - getId(b))

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 遍历任务队列，依次执行每个任务，
    // 这里需要注意一点：循环的结束条件使用了 queue.length 动态获取队列的长度，因为在执行已有任务期间可能会触发其它的副作用，
    // 副作用入队后会改变队列的长度，通过 queue.length 可以保证队列中的每个任务都被执行。
    // 这里需要配合 queueJob 方法理解，特别是 flushIndex 变量
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    // 重置队列索引
    flushIndex = 0
    // 清空队列
    queue.length = 0

    // 6. 执行需要在 渲染任务 后执行的任务，比如 options.flush 为 post 的用户 watcher（getter、回调）
    flushPostFlushCbs(seen)

    // 标识没有正处于刷新状态的队列
    isFlushing = false
    // 重置微任务的 Promise 实例
    currentFlushPromise = null
    // 检查三大队列，如果任一队列有了新的任务（刚才执行任务的时候可能会更改响应式状态，从而触发新的任务入队），则递归调用 flushJob 刷新队列
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    if (
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
