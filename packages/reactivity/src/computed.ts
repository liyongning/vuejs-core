import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

export class ComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  public _dirty = true
  public _cacheable: boolean

  constructor(
    // computed getter 函数
    getter: ComputedGetter<T>,
    // computed setter 函数
    private readonly _setter: ComputedSetter<T>,
    // 是否为只读，如果没有提供 setter 就是只读，否则为可写
    isReadonly: boolean,
    // 是否为同构渲染
    isSSR: boolean
  ) {
    // 实例化一个响应式副作用对象
    this.effect = new ReactiveEffect(getter, () => {
      // 当 computed 依赖的响应式数据发生变化后，该响应式副作用会被触发重新执行，即 effect.scheduler，
      // 这时 this._dirty 为 false，所以进入 if 分支，将 this._dirty 置为 true，
      // 触发依赖当前 computed ref 对象的副作用重新执行，比如组件更新函数，
      // 组件更新函数执行时，会执行 render，再次读取 computed ref 对象的 value，从而执行 effect.run 方法，执行 computed 的 getter
      if (!this._dirty) {
        this._dirty = true
        // 这里的 this 是 computed ref，即 ComputedRefImpl 的实例
        triggerRefValue(this)
      }
    })
    // 副作用对象上存储 computed 的返回值（ref 对象）
    this.effect.computed = this
    // 副作用是否激活
    this.effect.active = this._cacheable = !isSSR
    // computed 的返回值是否为只读 ref 对象
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  // 使用 computed 返回的 ref 对象读取数据时触发
  get value() {
    // 获取 computed ref 对象的原始值
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    // 收集依赖 computed ref 对象的副作用
    trackRefValue(self)
    // computed 缓存能力的关键，如果已经执行过一次 getter 函数，则将 _dirty 置为 false，再下次更新前不会重复执行 getter 消耗计算能力
    if (self._dirty || !self._cacheable) {
      // 将 _dirty 设置为 false，只有当副作用再次被触发时才会被设置为 true
      self._dirty = false
      // 通过副作用实例执行 computed getter 函数，拿到 getter 函数的返回值
      self._value = self.effect.run()!
    }
    // 返回 getter 函数返回的值
    return self._value
  }

  // 使用 computed 返回的 ref 对象设置新值时触发
  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
/**
 * 组合式 API computed
 * 1.接收一个 getter 函数，并为 getter 函数的返回值返回一个只读的 ref 对象
 * 2.接收一个含有 get、set 的配置项，创建一个可写的 ref 对象
 * @param getterOrOptions getter 函数 或 含有 get、set 选项的配置项
 * @param debugOptions 用户 debug 配置项，含有 onTrack 和 onTrigger 选项
 * @param isSSR 是否为同构渲染
 * @returns 
 */
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  // 根据 getterOrOptions 参数，设置 getter 和 setter
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  // 判断参数是否为函数
  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    // 如果参数是函数，则参数式 getter 函数
    getter = getterOrOptions
    // setter 在开发环境设置为一个 console 警告输出
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    // 参数为配置对象，分别设置 getter 和 setter
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 根据 getter 和 setter 创建 ref 对象
  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
