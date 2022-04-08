import {
  isRef,
  isShallow,
  Ref,
  ComputedRef,
  ReactiveEffect,
  isReactive,
  ReactiveFlags,
  EffectScheduler,
  DebuggerOptions
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet,
  isPlainObject
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import { DeprecationTypes } from './compat/compatConfig'
import { checkCompatEnabled, isCompatEnabled } from './compat/compatConfig'
import { ObjectWatchOptionItem } from './componentOptions'

export type WatchEffect = (onCleanup: OnCleanup) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup
) => any

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true
      ? V | undefined
      : V
    : T[K] extends object
    ? Immediate extends true
      ? T[K] | undefined
      : T[K]
    : never
}

type OnCleanup = (cleanupFn: () => void) => void

export interface WatchOptionsBase extends DebuggerOptions {
  flush?: 'pre' | 'post' | 'sync'
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

/**
 * Simple effect. 立即执行传入的 effect 函数，并且当 effect 函数依赖的响应式状态发生改变后重新执行 effect
 * @param effect 副作用函数
 * @param options 配置项，同 watch
 * @returns 
 */
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  // 第二个参数（回调）为 null，即相当于 watch(effect, null, options)
  return doWatch(effect, null, options)
}

/**
 * watchEffect 的别名，即 watchEffect(() => {}, { flush: 'post' })
 * 当响应式状态更新后，effect 在组件更新函数之后执行
 */
export function watchPostEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    (__DEV__
      ? Object.assign(options || {}, { flush: 'post' })
      : { flush: 'post' }) as WatchOptionsBase
  )
}

/**
 * watchEffect 的别名，即 watchEffect(() => {}, { flush: 'sync' })
 * 当响应式状态更新后，effect 会同步执行
 */
export function watchSyncEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    (__DEV__
      ? Object.assign(options || {}, { flush: 'sync' })
      : { flush: 'sync' }) as WatchOptionsBase
  )
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: multiple sources w/ `as const`
// watch([foo, bar] as const, () => {})
// somehow [...T] breaks when the type is readonly
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
/**
 * 侦听数据源，当数据源发生变化时执行回调函数，回调函数默认为懒执行
 * @param source 数据源
 * @param cb 回调函数
 * @param options 配置项 
 * @returns 
 */
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  source: T | WatchSource<T>,
  cb: any,
  options?: WatchOptions<Immediate>
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source as any, cb, options)
}

/**
 * watch API 的具体实现。
 * watch 的本质是 ReactiveEffect，当依赖的响应式状态发生改变后，触发 effect.run 方法（ watch source 生成的 getter 函数）重新执行，
 * 如果用户提供了回调函数（watchEffect 不需要设置回调），执行完 effect.run 方法后，执行副作用清除工作，然后执行回调函数。
 * 至于 effect.run 和 watch 回调具体如何执行，由 ReactiveEffect 的调度器决定，
 * watch 将 effect.run 和 回调封装成了一个 job，调度器根据 watch 配置参数决定 job 的执行时机，是同步执行？组件更新函数之后执行？
 * 还是默认的在组件更新函数之前执行
 */
function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ
): WatchStopHandle {
  // 开发环境参数设置不当时的异常提示
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  // 当用户提供了错误类型的 source 时的提示信息
  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  // 当前组件实例
  const instance = currentInstance
  // ReactiveEffect 类的第一个参数 fn
  let getter: () => any
  // 标时是否应当触发回调函数执行
  let forceTrigger = false
  // 是否多 source
  let isMultiSource = false

  // 根据不同类型 source，构建 ReactiveEffect 类的第一个参数（函数）
  if (isRef(source)) {
    // source 是 ref 对象
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    // source 是 reactive 对象
    getter = () => source
    // 如果 watch 监听 reactive 响应式对象，默认就是深度监听
    deep = true
  } else if (isArray(source)) {
    // source 是数组，即多数据源
    isMultiSource = true
    forceTrigger = source.some(isReactive)
    // getter 函数的返回值是数组，数组元素 source 数组中每个的值，比如：解包后的 ref 值、函数的执行结果
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    // source 是函数
    if (cb) {
      // 带回调的 getter
      // getter with cb
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // 没有指定回调函数，就是一个简单的 副作用，比如 watchEffect
      // no cb -> simple effect
      getter = () => {
        if (instance && instance.isUnmounted) {
          return
        }
        if (cleanup) {
          cleanup()
        }
        return callWithAsyncErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onCleanup]
        )
      }
    }
  } else {
    // 提供了错误类型的 source，抛出提示信息
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 2.x array mutation watch compat
  if (__COMPAT__ && cb && !deep) {
    const baseGetter = getter
    getter = () => {
      const val = baseGetter()
      if (
        isArray(val) &&
        checkCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance)
      ) {
        traverse(val)
      }
      return val
    }
  }

  // 有回调函数，并且是深度监听
  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  // 清除副作用，用于在副作用即将重新执行时、侦听器被停止时执行
  let cleanup: () => void
  let onCleanup: OnCleanup = (fn: () => void) => {
    cleanup = effect.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  if (__SSR__ && isInSSRComponentSetup) {
    // we will also not call the invalidate callback (+ runner is not set up)
    onCleanup = NOOP
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        isMultiSource ? [] : undefined,
        onCleanup
      ])
    }
    return NOOP
  }

  // 监听的响应式状态的旧值，如果是多数据源，则是空数组，否则为空对象
  let oldValue = isMultiSource ? [] : INITIAL_WATCHER_VALUE
  // 调度任务，执行 getter 函数，拿到最新的状态值，如果用户传递了回调函数，则先清理副作用，然后执行回调函数
  const job: SchedulerJob = () => {
    // effect.active 为 false，则说明已经停止侦听，直接返回
    if (!effect.active) {
      return
    }
    if (cb) {
      // 存在回调函数，则说明是：watch(source, cb)
      // 执行 effect.run 方法，即由 watch source 构成的 getter 函数，拿到新的状态值
      const newValue = effect.run()
      // 当深度监听时 || 强制触发更新时 || 新旧值发生改变，执行副作用清理，然后执行回调函数
      if (
        // 深度监听
        deep ||
        // 强制触发
        forceTrigger ||
        // 新旧值是否发生改变
        (isMultiSource
          ? (newValue as any[]).some((v, i) =>
              hasChanged(v, (oldValue as any[])[i])
            )
          : hasChanged(newValue, oldValue)) ||
        (__COMPAT__ &&
          isArray(newValue) &&
          isCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance))
      ) {
        // 在回调被重新执行前清除副作用
        // cleanup before running cb again
        if (cleanup) {
          cleanup()
        }
        // 执行回调函数，回调函数的参数设置也是在这里进行的
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onCleanup
        ])
        // 更新旧值
        oldValue = newValue
      }
    } else {
      // 没有指定回调，比如 watchEffect，直接执行 getter
      effect.run()
    }
  }

  // 是否允许调度任务自己触发
  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb

  // 定义 ReactiveEffect 类的第二个参数 —— 调度器，指定当数据源更新后，如果执行 job
  // 默认为 pre，即所有用户定义的副作用在组件更新函数前执行
  // sync 表示同步执行，每个响应式状态改变都会同步执行副作用
  // post 用户定义的副作用在组件更新函数之后执行
  let scheduler: EffectScheduler
  if (flush === 'sync') {
    // 同步，当响应式状态更改后，副作用会被直接调用执行
    scheduler = job as any // the scheduler function gets called directly
  } else if (flush === 'post') {
    // 将用户定义的副作用放到队列中，该队列的内容会在组件更新函数之后执行
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // 默认值，pre，将用户定义的副作用放入队列，该队列的内容会在组件更新函数前执行
    // default: 'pre'
    scheduler = () => {
      if (!instance || instance.isMounted) {
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        job()
      }
    }
  }

  // 实例化响应式副作用
  const effect = new ReactiveEffect(getter, scheduler)

  if (__DEV__) {
    effect.onTrack = onTrack
    effect.onTrigger = onTrigger
  }

  // 初始化运行
  // initial run
  if (cb) {
    // 如果存在回调函数，并且指定了立即执行，则直接执行 job，否则执行 effect.run，得到数据源的初始值
    if (immediate) {
      job()
    } else {
      oldValue = effect.run()
    }
  } else if (flush === 'post') {
    // 将 effect.run 放入队列，在组件更新函数之后执行
    queuePostRenderEffect(
      effect.run.bind(effect),
      instance && instance.suspense
    )
  } else {
    // 直接执行 getter，比如 watchEffect
    effect.run()
  }

  // watch 函数的返回值，执行该函数可停止 watch 侦听，其实本质上就是清空依赖，当响应式数据更改后，不再触发相应副作用
  return () => {
    effect.stop()
    if (instance && instance.scope) {
      remove(instance.scope.effects!, effect)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  let cb
  if (isFunction(value)) {
    cb = value
  } else {
    cb = value.handler as Function
    options = value
  }
  const cur = currentInstance
  setCurrentInstance(this)
  const res = doWatch(getter, cb.bind(publicThis), options)
  if (cur) {
    setCurrentInstance(cur)
  } else {
    unsetCurrentInstance()
  }
  return res
}

/**
 * 返回函数作为 watcher 的 getter，函数最终返回 this.path 对象
 * @param ctx this
 * @param path 对象 key 路径，k1.kk1
 * @returns 函数，作为 watcher 的 getter
 */
export function createPathGetter(ctx: any, path: string) {
  // 将 key 按照 . 分割为数组，[k1, kk1]
  const segments = path.split('.')
  // 返回函数，作为 watcher 的 getter，函数返回 cur.k1.kk1 对象
  return () => {
    let cur = ctx
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}

export function traverse(value: unknown, seen?: Set<unknown>) {
  // value 为 非对象 或者 含有 __v_skip 属性，则直接返回原数据
  if (!isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }
  seen = seen || new Set()
  if (seen.has(value)) {
    return value
  }
  seen.add(value)
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse((value as any)[key], seen)
    }
  }
  return value
}
