import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    if (!this.active) {
      return this.fn()
    }
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      this.parent = activeEffect
      activeEffect = this
      shouldTrack = true

      trackOpBit = 1 << ++effectTrackDepth

      if (effectTrackDepth <= maxMarkerBits) {
        initDepMarkers(this)
      } else {
        cleanupEffect(this)
      }
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        finalizeDepMarkers(this)
      }

      trackOpBit = 1 << --effectTrackDepth

      activeEffect = this.parent
      shouldTrack = lastShouldTrack
      this.parent = undefined
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const _effect = new ReactiveEffect(fn)
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

// 控制依赖收集是否进行
export let shouldTrack = true
// 栈，存储 shouldTrack 的上一状态
const trackStack: boolean[] = []

// 暂停依赖收集
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

// 允许依赖收集
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

// 恢复 shouldTrack 到上一状态
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * 依赖收集，收集 target[key] 依赖的副作用，并将依赖集合在当前激活的副作用上也记录一份
 * @param target 目标对象
 * @param type 操作类型
 * @param key 属性
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 允许跟踪 && 当前有激活的副作用实例
  if (shouldTrack && activeEffect) {
    // 获取目标对象的依赖对象
    let depsMap = targetMap.get(target)
    // 如果该对象没有收集过依赖对象，则创建
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 获取 target[key] 对应的 依赖集合，如果没有则创建
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined

    // 为响应式数据收集副作用，相当于记录自己的订阅者，知道了有哪些副作用依赖自己，待将来自己更新时好重新去执行这些副作用
    trackEffects(dep, eventInfo)
  }
}

/**
 * 为响应式数据收集副作用，相当于记录自己的订阅者，知道了有哪些副作用依赖自己，待将来自己更新时好重新去执行这些副作用
 * @param dep 响应数据的副作用集合
 * @param debuggerEventExtraInfo 
 */
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    // 为响应式数据收集副作用，相当于记录自己的订阅者，知道了有哪些副作用依赖自己，待将来自己更新时好重新去执行这些副作用
    dep.add(activeEffect!)
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

/**
 * 根据目标对象、key、操作类型，获取相关的副作用，然后触发这些副作用重新执行
 * @param target 目标对象
 * @param type 操作类型
 * @param key 操作的 key（属性 or 索引）
 * @param newValue 新值
 * @param oldValue 旧值
 * @param oldTarget 
 * @returns 
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取对象的依赖映射对象，该对象以 target 的 key 为键，副作用集合为 value
  const depsMap = targetMap.get(target)
  // 如果集合不存在，则说明从来没收集过 target 对象的依赖，直接返回
  if (!depsMap) {
    // never been tracked
    return
  }

  // 存放所有将要被执行的副作用
  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // 集合的 clear 操作，说明是清空集合，则触发所有相关的副作用
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 说明修改的是数组的 length 属性，arrProxy.length = newVal
    // 遍历数组，获取和 length 属性相关的副作用以及所有索引（key）大于等于新 length 值的相关副作用
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // set、add 和 delete 操作
    // schedule runs for SET | ADD | DELETE
    // 获取 target.key 对应的副作用集合
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // 收集需要触发 add、delete、Map.set 操作的迭代相关的副作用
    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      // 新增操作，获取普通对象、Map 对象、数组迭代相关的副作用
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          // 普通对象迭代相关的副作用
          deps.push(depsMap.get(ITERATE_KEY))
          // Map 对象迭代相关的副作用
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 数组添加了新元素，获取 length 属性相关的副作用
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      // 删除操作，获取普通对象、Map 对象迭代相关的副作用
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      // 修改操作，获取 Map 对象迭代相关的副作用
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  // 触发待执行的副作用
  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

/**
 * 触发副作用
 *  遍历副作用集合，如果副作用没有运行 或 允许被递归，则执行副作用，
 *  如果副作用有调度器，则按照调度器的指示去执行，如果没有则执行副作用的 run 方法
 * @param dep 副作用集合
 * @param debuggerEventExtraInfo 
 */
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // 遍历副作用集合
  // spread into array for stabilization
  for (const effect of isArray(dep) ? dep : [...dep]) {
    // 如果副作用没有运行 或者 副作用允许递归
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      if (effect.scheduler) {
        // 副作用有调度器，则执行调度器，则副作用将按照调度器指示的方式执行
        effect.scheduler()
      } else {
        // 执行副作用的 run 方法
        effect.run()
      }
    }
  }
}
