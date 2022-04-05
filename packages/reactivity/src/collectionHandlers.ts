import { toRaw, ReactiveFlags, toReactive, toReadonly } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { capitalize, hasOwn, hasChanged, toRawType, isMap } from '@vue/shared'

export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

// 返回值本身
const toShallow = <T extends unknown>(value: T): T => value

// 获取对应的原型对象
const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

/**
 * 拦截集合的 get 方法，当触发时进行依赖收集，并对返回值做处理（响应式、浅响应、只读）
 * @param target 代理对象
 * @param key key
 * @param isReadonly 是否只读
 * @param isShallow 是否浅响应
 * @returns 
 */
function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // 获取对象、key 的 原始值
  // #1772: readonly(reactive(Map)) should return readonly + reactive version of the value
  target = (target as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  // 如果 key 和自己的原始值不一样，则说明 key 是响应式的值（proxy 和 原始对象不相等），对 target[key] 进行依赖收集
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }
  // 对 target[rawKey] 进行依赖收集
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)
  // 从对象的原型对象上获取原生的 has 方法
  const { has } = getProto(rawTarget)
  // 根据参数，返回相应的方法，这些方法可以对值进行浅响应式处理、只读处理、响应式处理
  const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
  // 用 wrap 包裹返回值
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  } else if (target !== rawTarget) {
    // #3602 readonly(reactive(Map))
    // ensure that the nested reactive `Map` can do tracking for itself
    target.get(key)
  }
}

/**
 * 拦截集合的 has 方法，触发时进行依赖收集，并通过原始对象的 has 方法返回执行结果
 * @param this 对象的 proxy 代理
 * @param key 
 * @param isReadonly 
 * @returns 
 */
function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  // 原始对象
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  // 原始 key
  const rawKey = toRaw(key)
  // 依赖收集
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)
  // 执行原始对象的 has 方法，并返回结果
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}

/**
 * 拦截集合的 size 方法，触发时进行依赖收集，通过原始对象的 size 方法获取集合的大小
 * @param target 代理对象
 * @param isReadonly 
 * @returns 
 */
function size(target: IterableCollections, isReadonly = false) {
  // 代理对象的原始对象
  target = (target as any)[ReactiveFlags.RAW]
  // 依赖收集，key 是 ITERATE_KEY
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  // 执行集合的默认 size 方法，返回集合的大小
  return Reflect.get(target, 'size', target)
}

/**
 * 拦截集合的 add 方法，触发时调用原始对象的 add 方法添加元素，并触发相关副作用重新执行，最后返回 proxy 代理
 * @param this 代理对象
 * @param value 被添加的值
 * @returns 
 */
function add(this: SetTypes, value: unknown) {
  // 获取值和对象的原始值
  value = toRaw(value)
  const target = toRaw(this)
  // 原型对象
  const proto = getProto(target)
  // 判断集合是否已经存在该值
  const hadKey = proto.has.call(target, value)
  // 如果不存在则调用原始对象的 add 方法添加，并触发相关副作用重新执行
  if (!hadKey) {
    target.add(value)
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  // 返回代理对象
  return this
}

/**
 * 拦截集合的 set 方法，通过原始对象的 set 方法设置 key、value，然后执行 trigger 重新执行相关副作用，最后返回 proxy 代理
 * @param this proxy 代理
 * @param key key
 * @param value 对应的值
 * @returns 
 */
function set(this: MapTypes, key: unknown, value: unknown) {
  // 获取值和代理对象的原始值，直接操作原始对象，另外值也是原始值，是为了避免将响应式的值设置到原始对象上，造成原始数据的污染
  value = toRaw(value)
  const target = toRaw(this)
  // 从对象的原型上获取原生的 has 和 get 方法
  const { has, get } = getProto(target)

  // 查看原始对象上是否存在指定的 key
  let hadKey = has.call(target, key)
  // 如果不存在，则获取 key 的原始值，并判断原始 key 是否已经存在于原始对象上了
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  // 获取旧值
  const oldValue = get.call(target, key)
  // 通过原始对象设置新值
  target.set(key, value)
  // 执行 trigger，根据 key 是否存在传递不同的操作类型，触发相关副作用重新执行
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  // 返回 proxy 代理
  return this
}

/**
 * 拦截集合的 delete 操作，通过原始对象执行 delete 操作删除 key，如果 key 存在执行 trigger 方法触发相关副作用重新执行，然后返回 delete 的执行结果
 * @param this 对象的 proxy 代理
 * @param key 要删除的 key
 * @returns 
 */
function deleteEntry(this: CollectionTypes, key: unknown) {
  // 获取原始对象
  const target = toRaw(this)
  // 获取原型对象上的 has 和 get 方法
  const { has, get } = getProto(target)
  // 判断原始对象上是否存在指定的 key
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  // 获取 target[key]
  const oldValue = get ? get.call(target, key) : undefined
  // 执行原始对象的 delete 操作
  // forward the operation before queueing reactions
  const result = target.delete(key)
  // 如果 key 存在，则执行 trigger 触发相关副作用重新执行
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  // 返回 delete 的执行结果
  return result
}

/**
 * 拦截集合的 clear 方法，通过原始对象的 clear 方法清空集合，执行 trigger 方法触发相关副作用重新执行，然后返回 clear 的执行结果
 * @param this 对象的 proxy 代理
 * @returns 
 */
function clear(this: IterableCollections) {
  // 原始对象
  const target = toRaw(this)
  // 对象是否为空
  const hadItems = target.size !== 0
  // 克隆现有对象
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // 通过原始对象的 clear 方法清空集合
  // forward the operation before queueing reactions
  const result = target.clear()
  // 如果集合本来不为空，则执行 trigger 方法触发相关副作用重新执行
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  // 返回 clear 的执行结果
  return result
}

/**
 * forEach 工厂函数，根据参数不同，返回不同的 forEach 方法
 * @param isReadonly 是否只读
 * @param isShallow 是否浅响应
 * @returns 
 */
function createForEach(isReadonly: boolean, isShallow: boolean) {
  /**
   * 拦截集合的 forEach 方法，执行原生对象的 forEach 方法，forEach 的 callback 函数的参数需要处理：
   * 1. callback 的执行上下文是响应式对象
   * 2. value、key 需要包裹处理（响应式、只读、浅响应）
   */
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    // 响应式代理对象
    const observed = this as any
    // 代理对象的原始对象
    const target = observed[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    // 根据参数，返回相应的方法，这些方法可以对值进行浅响应式处理、只读处理、响应式处理
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    // 依赖收集，key 是 ITERATE_KEY
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    // 返回原始对象的 forEach 执行结果
    return target.forEach((value: unknown, key: unknown) => {
      // callback 执行时，一定要确保：
      // 1. value、key 需要处理（响应式、只读、浅响应）
      // 2. callback 的执行上下文需要是 proxy 代理对象
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}

interface Iterable {
  [Symbol.iterator](): Iterator
}

interface Iterator {
  next(value?: any): IterationResult
}

interface IterationResult {
  value: any
  done: boolean
}

/**
 * 可迭代方法工厂函数，根据参数名不同，创建对应的迭代方法
 * @param method 方法名
 * @param isReadonly 是否只读
 * @param isShallow 是否浅响应
 * @returns 
 */
function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean
) {
  /**
   * 拦截集合的迭代器方法，
   * 1.执行原生的迭代器方法得到迭代器对象，
   * 2.执行 track 方法进行依赖收集，
   * 3.方法内部自定义了迭代器对象，对迭代产生的值做了响应式处理
   */
  return function (
    // 对象的 proxy 代理
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    // 代理对象的原始对象
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    // 是否为 Map 对象
    const targetIsMap = isMap(rawTarget)
    // 标识是否为 entries 和 iterator，entries 和 iterator 是同一个对象
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    // keys 方法
    const isKeyOnly = method === 'keys' && targetIsMap
    // 执行原始对象上迭代器方法，比如 target[Symbol.iterator]、target.entries、target.values、target.keys，拿到迭代器对象
    const innerIterator = target[method](...args)
    // 根据参数，返回相应的方法，这些方法可以对值进行浅响应式处理、只读处理、响应式处理
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    // 依赖收集，key 为 ITERATE_KEY 或 MAP_KEY_ITERATE_KEY
    // MAP_KEY_ITERATE_KEY 是为了针对 target.keys 方法，因为操作集合的值时，key 相关的副作用不需要重新执行
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // 这里没有直接返回原生的迭代器对象，是为了处理迭代值的响应式问题，迭代产生的值也需要是响应式的，所以这里自定义了迭代器对象
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    return {
      // 迭代器协议
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
              // 对迭代产生的值做响应式处理
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // 可迭代协议
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

/**
 * 创建只读方法，如果是删除操作则返回 false，如果是其它操作则返回对象本身
 * @param type 操作类型
 * @returns 
 */
function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this
  }
}

/**
 * 自定义集合的操作方法（get、size、add、set、delete、clear、forEach、迭代器方法）
 */
function createInstrumentations() {
  // 响应式对象的 handler
  const mutableInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, false)
  }

  // 浅响应式的 handler
  const shallowInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, false, true)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, true)
  }

  // 只读响应的 handler
  const readonlyInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, false)
  }

  // 浅只读的 handler
  const shallowReadonlyInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, true)
  }

  // 在 handler 对象上定义集合的迭代器方法（keys、values、entries、Sysbol.iterator）
  const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
  iteratorMethods.forEach(method => {
    mutableInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      false
    )
    readonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      false
    )
    shallowInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      true
    )
    shallowReadonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      true
    )
  })

  // 返回集合的各个 handler 对象
  return [
    mutableInstrumentations,
    readonlyInstrumentations,
    shallowInstrumentations,
    shallowReadonlyInstrumentations
  ]
}

const [
  mutableInstrumentations,
  readonlyInstrumentations,
  shallowInstrumentations,
  shallowReadonlyInstrumentations
] = /* #__PURE__*/ createInstrumentations()

/**
 * 创建集合对象的 proxy handler.getter，以拦截集合对象的相关操作
 * @param isReadonly 是否只读
 * @param shallow 是否浅响应
 * @returns 
 */
function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 经过重写的集合类型的相关方法和属性
  const instrumentations = shallow
    ? isReadonly
      // 浅只读
      ? shallowReadonlyInstrumentations
      // 浅响应
      : shallowInstrumentations
    : isReadonly
    // 只读
    ? readonlyInstrumentations
    // 正常情况
    : mutableInstrumentations

  /**
   * getter 函数，返回集合类型的指定方法或属性，这些方法和属性有可能是原生的也有可能是经过重写的
   */
  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    // 特殊处理，比如查看对象是否为响应式对象、是否只读、查看对象的原始数据等
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    // 拦截集合对象的 getter 操作，执行自定义的操作方法，比如自定义的 get、set、size 等方法
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

/**
 * 集合数据类型的 proxy handler，集合类型和普通对象类型不一样，数据操作有一套自己独立的 API，
 * 通过 API 操作数据时都会触发 getter 访问器，因为要拿对象上的指定属性（比如 size）或方法（比如 delete），
 * 所以集合数据类型的 handler 就一个 getter，getter 会返回一个自定义的对象，该对象重写（增强）了集合类型的相关方法和属性
 */
export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, false)
}

/**
 * 集合的浅响应处理的 proxy handler
 */
export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, true)
}

/**
 * 集合的只读处理的 proxy handler
 */
export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(true, false)
}

/**
 * 集合的浅只读浅处理的 proxy handler
 */
export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*#__PURE__*/ createInstrumentationGetter(true, true)
  }

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
