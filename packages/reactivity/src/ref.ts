import {
  activeEffect,
  shouldTrack,
  trackEffects,
  triggerEffects
} from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, hasChanged, IfAny } from '@vue/shared'
import { isProxy, toRaw, isReactive, toReactive } from './reactive'
import type { ShallowReactiveMarker } from './reactive'
import { CollectionTypes } from './collectionHandlers'
import { createDep, Dep } from './dep'

declare const RefSymbol: unique symbol

export interface Ref<T = any> {
  value: T
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true
}

type RefBase<T> = {
  dep?: Dep
  value: T
}

/**
 * 为 ref 值数据副作用，在 ref.dep 集合中记录依赖自己的副作用，将来 ref 更新时，重新执行这些副作用 
 */
export function trackRefValue(ref: RefBase<any>) {
  // 允许被跟踪 && 有正处于激活状态的副作用
  if (shouldTrack && activeEffect) {
    // 获取 ref 的原始值
    ref = toRaw(ref)
    // 为 ref 数收集副作用，在 ref.dep 集合中记录依赖自己的副作用，将来自己更新时，重新执行这些副作用
    if (__DEV__) {
      trackEffects(ref.dep || (ref.dep = createDep()), {
        target: ref,
        type: TrackOpTypes.GET,
        key: 'value'
      })
    } else {
      trackEffects(ref.dep || (ref.dep = createDep()))
    }
  }
}

/**
 * 触发 ref 对象的订阅者（依赖 ref 对象的副作用）重新执行
 * @param ref ref 对象
 * @param newVal 更新 ref 对象的新值
 */
export function triggerRefValue(ref: RefBase<any>, newVal?: any) {
  // 从 ref 原始值的 dep 对象上拿到依赖自己的副作用集合
  ref = toRaw(ref)
  if (ref.dep) {
    if (__DEV__) {
      triggerEffects(ref.dep, {
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: newVal
      })
    } else {
      // 触发副作用：遍历副作用集合，依次触发副作用执行
      triggerEffects(ref.dep)
    }
  }
}

export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
// 判断参数是否为 ref 值，通过 __v_isRef 标识来 判断
export function isRef(r: any): r is Ref {
  return !!(r && r.__v_isRef === true)
}

export function ref<T extends object>(
  value: T
): [T] extends [Ref] ? T : Ref<UnwrapRef<T>>
export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>
/**
 * ref API，返回 ref 实例。ref API 主要是为了方便代理原始值，当然也可以代理对象
 * @param value 被代理的值
 * @returns ref 实例
 */
export function ref(value?: unknown) {
  return createRef(value, false)
}

declare const ShallowRefMarker: unique symbol

export type ShallowRef<T = any> = Ref<T> & { [ShallowRefMarker]?: true }

export function shallowRef<T extends object>(
  value: T
): T extends Ref ? T : ShallowRef<T>
export function shallowRef<T>(value: T): ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

/**
 * 创建 ref 实例
 * @param rawValue 原始值
 * @param shallow 
 * @returns 
 */
function createRef(rawValue: unknown, shallow: boolean) {
  // 如果 raValue 已经是 ref 值，则直接返回
  if (isRef(rawValue)) {
    return rawValue
  }
  // 实例化 Ref，返回 ref 实例
  return new RefImpl(rawValue, shallow)
}

/**
 * ref API 的响应式实现
 *  通过 getter 和 setter 来拦截对 ref.value 的读取和设置，
 *  读取时，收集依赖 ref 值的副作用，并返回 ref 值
 *  设置时，更新 ref 值，并触发依赖 ref 值的副作用重新执行
 * 如果是浅响应，原始值和对象的处理方式一样，都是将值直接赋值给 this._value，
 * 否则对象会经有 reactive API 处理，将返回的 proxy 代理赋值给 this._value
 */
class RefImpl<T> {
  private _value: T
  private _rawValue: T

  public dep?: Dep = undefined
  public readonly __v_isRef = true

  constructor(value: T, public readonly __v_isShallow: boolean) {
    // 原始值
    this._rawValue = __v_isShallow ? value : toRaw(value)
    // 如果是浅响应或值为非对象，this.__value 等于值本身，否则等于经过 reactive 转换后的响应式对象
    this._value = __v_isShallow ? value : toReactive(value)
  }

  // 读取 ref.value 时触发，收集副作用并返回 this._value
  get value() {
    // 为 ref 值收集副作用，在 ref.dep 集合中记录依赖自己的副作用，将来 ref 更新时，重新执行这些副作用 
    trackRefValue(this)
    return this._value
  }

  // 设置 ref.value 时触发，更新 ref 值，并触发依赖 ref 对象的副作用重新执行
  set value(newVal) {
    // 获取新值的原始值
    newVal = this.__v_isShallow ? newVal : toRaw(newVal)
    // 通过 Object.is 对比新旧两个原始值，看是否发生变化，如果变了
    if (hasChanged(newVal, this._rawValue)) {
      // 更新原始值
      this._rawValue = newVal
      // 和初始化时一样的方式，更新 this._value
      this._value = this.__v_isShallow ? newVal : toReactive(newVal)
      //触发 ref 对象的订阅者（依赖 ref 对象的副作用）重新执行
      triggerRefValue(this, newVal)
    }
  }
}

export function triggerRef(ref: Ref) {
  triggerRefValue(ref, __DEV__ ? ref.value : void 0)
}

/**
 * 如果参数是 ref，则返回内部值，否则返回参数本身
 */
export function unref<T>(ref: T | Ref<T>): T {
  return isRef(ref) ? (ref.value as any) : ref
}

/**
 * 代理 ref 值的 get 和 set 操作，这里其实就是一个针对 ref 数据的语法糖
 *  get: 如果访问的属性值是 ref，则返回内部值，即 ref.value，否则返回值本身
 *  set: 如果旧值是 ref，则将新值设置给 ref.value，否则，直接赋值给 ref 本身
 */
const shallowUnwrapHandlers: ProxyHandler<any> = {
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}

/**
 * 创建对象代理，拦截对象的 get 和 set 操作。 
 * 如果属性值时 ref，则操作 ref.value，否则直接操作值本身
 */
export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

export type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

class CustomRefImpl<T> {
  public dep?: Dep = undefined

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    const { get, set } = factory(
      () => trackRefValue(this),
      () => triggerRefValue(this)
    )
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}

export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  [K in keyof T]: ToRef<T[K]>
}
export function toRefs<T extends object>(object: T): ToRefs<T> {
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  const ret: any = isArray(object) ? new Array(object.length) : {}
  for (const key in object) {
    ret[key] = toRef(object, key)
  }
  return ret
}

class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true

  constructor(
    private readonly _object: T,
    private readonly _key: K,
    private readonly _defaultValue?: T[K]
  ) {}

  get value() {
    const val = this._object[this._key]
    return val === undefined ? (this._defaultValue as T[K]) : val
  }

  set value(newVal) {
    this._object[this._key] = newVal
  }
}

export type ToRef<T> = IfAny<T, Ref<T>, [T] extends [Ref] ? T : Ref<T>>

export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): ToRef<T[K]>

export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
  defaultValue: T[K]
): ToRef<Exclude<T[K], undefined>>

export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
  defaultValue?: T[K]
): ToRef<T[K]> {
  const val = object[key]
  return isRef(val)
    ? val
    : (new ObjectRefImpl(object, key, defaultValue) as any)
}

// corner case when use narrows type
// Ex. type RelativePath = string & { __brand: unknown }
// RelativePath extends object -> true
type BaseTypes = string | number | boolean

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 *
 * Note that api-extractor somehow refuses to include `declare module`
 * augmentations in its generated d.ts, so we have to manually append them
 * to the final generated d.ts in our build process.
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V>
    ? V
    : // if `V` is `unknown` that means it does not extend `Ref` and is undefined
    T[K] extends Ref<infer V> | undefined
    ? unknown extends V
      ? undefined
      : V | undefined
    : T[K]
}

export type UnwrapRef<T> = T extends ShallowRef<infer V>
  ? V
  : T extends Ref<infer V>
  ? UnwrapRefSimple<V>
  : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Function
  | CollectionTypes
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  ? T
  : T extends Array<any>
  ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
  : T extends object & { [ShallowReactiveMarker]?: never }
  ? {
      [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
    }
  : T
