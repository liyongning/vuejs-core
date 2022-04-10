import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

// 创建 getter 拦截器
const get = /*#__PURE__*/ createGetter()
// 浅响应的 getter 拦截器，和普通的 getter 区别是对返回值不做深层次的响应式处理，即直接返回结果，不递归调用 reactive 方法
const shallowGet = /*#__PURE__*/ createGetter(false, true)
// 只读对象的 getter 拦截器，和普通 getter 的区别是不做依赖收集，且是深层次只读
const readonlyGet = /*#__PURE__*/ createGetter(true)
// 浅只读的 getter 拦截器，和普通 getter 的区别是只对根属性做只读处理
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

/**
 * 根据规范可知，数组的内部方法都依赖了对象的基本语义，比如 includes 依赖 数组的索引和 length 属性，所以当数组
 * 的某个元素改变或者数组长度变了时，就会触发响应（相应副作用执行）。
 * 当然下面指定的 8 个方法不算在副作用里面，这些方法只负责查看数组是否有某个元素或者改变数组自身，这里的方法重写只是为了
 * 在代理的情况下让方法具有正确的执行结果。
 */
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  /**
   * 自定义数组的 includes、indexOf、lastIndexOf 方法，这三个方法都是负责查找数组中是否存在某个元素，
   * 而自定义它们是为了解决非只读数组且元素为非原始值的情况，因为这种情况下数组元素是代理，而为原始数据，比如：
   * const obj = { k1: 'v1' }
   * const arrProxy = reactive([obj])
   * console.log(arrProxy.includes(obj)) // 正常情况来说应该返回 true，但如果没有这里的自定义则会返回 false
   * 原因如下：arrProxy.includes 方法内部的 this 指向 arrProxy，而 includes 内部通过 this 获取数组元素时获取
   * 到的也是元素的 proxy 代理，obj 和 proxy 代理当然不相等了，所以就返回了 false
   */
  // instrument identity-sensitive Array methods to account for possible reactive values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    /**
     * 以 arrProxy.includes(ele) 为例进行说明，indexOf 和 lastIndexOf 同理
     * @param this 数组的 proxy 代理
     * @param args 参数，比如 ele
     * @returns 
     */
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 获取原始数组对象
      const arr = toRaw(this) as any
      // 为数组的每个元素进行依赖收集，target 为 arr，key 为 索引，当这些元素发生改变时，就会重新执行这三个查找方法所在的副作用了
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // 执行原始对象上的方法，比如 arr.includes(...args)，看是否存在 args，这里的 args 可能是 proxy 代理，
      // 比如数组元素是对象，则会递归的调用 reactive 对元素值也进行响应式处理，这时候 res 就会返回 false，因为
      // 元素的代理和元素本身是不相等的
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // 如果上面的方法执行后没找到元素，则将参数 args 转换为原始值，从数组中查找原始值，看能否找到，将查找结果返回
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })

  /**
   * 以下方法会改变数组长度，当这些方法被放在副作用函数中时，就会让 length 和 这些副作用函数关联，在某些情况下导致死循环。
   * 比如：
   * const arr = reactive([])
   * watchEffect(() => {
   *    // 副作用一
   *    arr.push(1)
   * })
   * watchEffect(() => {
   *    // 副作用二
   *    arr.push(2)
   * })
   * 根据规范可知，当使用 push 方法向数组添加元素时，会读取数组的 length 属性，导致 length 属性和这里的两个副作用建立联系，
   * 当执行副作用一时，数组的 length 属性被改变，就会触发副作用用二执行，同理副作用二也会改变数组的 length 属性，又触发副作用一
   * 执行，导致死循环。
   * 其实 push、pop 等这些方法的本意是修改数组本身，所以我们根本就不需要让它们和 length 属性建立联系，
   * 所以这里的方法意在配合 track 切断 length 和 push、pop 等方法之间的联系，让这些方法只是单纯的修改
   * 数组本身即可，不需要和 length 建立联系。
   */
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 暂停依赖收集，即 shouldTrack 置为 false
      pauseTracking()
      // 这里的 this 是数组的 proxy 代理
      // 执行数组的 push、pop 等方法，完成数组的修改，由于这会儿暂停了依赖手机，所以即时 length 属性
      // 被关变，也不会建立 length 和 该方法的联系
      const res = (toRaw(this) as any)[key].apply(this, args)
      // 到这里方法执行结束，恢复 shouTrack 的上一状态
      resetTracking()
      // 返回执行结果
      return res
    }
  })
  return instrumentations
}

/**
 * getter 工厂函数，根据参数不同，创建不同的 getter 函数
 * @param isReadonly 是否为只读，如果是只读则不需要做依赖收集
 * @param shallow 是否为浅响应，如果为浅响应，则不需要对内层属性做响应式处理
 * @returns getter 函数
 */
function createGetter(isReadonly = false, shallow = false) {
  /**
   * 拦截对象的读取操作：获取读取的值，调用 track 方法进行依赖收集（非只读），
   * 如果读取的值为对象，则递归进行响应式处理（非浅响应式），最后返回数据的响应式代理，否则直接返回原始值
   */
  return function get(target: Target, key: string | symbol, receiver: object) {
    // 过滤掉对象上的一些特殊属性，比如 __v_isReactive、__v_isReadonly、__v_isShallow、__v_raw，
    // 如果 key 是这些属性，则返回这些属性上保存的对应的值
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      // key === __v_raw，返回存储在对应集合中 target 对应的 proxy 实例
      return target
    }

    // 判断 target 是否为数组
    const targetIsArray = isArray(target)

    // 操作的数据为非只读的数组 && 是通过重写的 8 个数组方法来操作的，则执行数组的自定义拦截方法
    // 拦截方法包括：includes、indexOf、lastIndexOf、push、pop、unshift、shift、splice
    // 这些自定义方法解决了原生方法在响应式系统中的一些问题，让它们在响应式系统中具有正确的执行结果
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 执行数据读取的默认行为，拿到执行结果
    const res = Reflect.get(target, key, receiver)

    // 过滤对 Symbol 属性，为了避免一些意外错误，以及性能上的考虑，不应该在 Symbol 属性和副作用之间建立响应关系。
    // 比如使用 for of 遍历数组、数组的 values 属性，都会读取数组的 Symbol.iterator 属性
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 如果是非只读数据，则执行依赖收集
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 如果是浅响应，则只处理对象最外层数据即可，直接返回
    if (shallow) {
      return res
    }

    /**
     * 如果返回的查找结果为 ref 值 &&（不是数组 || key 不是整数）则自动解包 ref 值
     * const num = ref(2)
     * const arr = reactive([1, num, 3])
     * console.log(arr[1])
     * // 这里的 ref 就不会被解包，说出的结果是一个 ref 值
     */
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    // 如果返回值为对象，对返回值进行响应式（或只读）处理，这里又叫深度响应式或深度只读。
    // 相比 Vue2，这里其实做了优化，内层对象只有在被实际读取时才进行响应式处理，所以又叫懒响应式，可以减少初始化时的时间；
    // 而 Vue2 在初始化时会递归处理对象的所有属性，所以 Vue2 建议 data 返回的对象不要嵌套太深，以降低初始化时间。
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    // 返回值
    return res
  }
}

// 创建 setter 拦截器
const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

/**
 * setter 工厂函数，根据参数创建不同的 setter 函数
 * @param shallow 是否为浅响应
 * @returns setter 函数
 */
function createSetter(shallow = false) {
  /**
   * 拦截对象的设置操作：更新数据，调用 trigger 方法触发相关副作用重新执行
   */
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    // 旧值
    let oldValue = (target as any)[key]
    // 异常情况，旧值为只读 && 旧值为 ref 值 && 新值不是 ref 值，则直接返回 false，表示更新失败
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    // 不是浅响应 && 新值不是只读，获取新旧值的原始值
    if (!shallow && !isReadonly(value)) {
      // 如果新值不是浅响应，则获取新旧值的原始值，以保证最后执行默认 set 方法时，给原始对象设置的是原始值，避免发生原始数据污染（原始对象设置响应式的值）
      if (!isShallow(value)) {
        value = toRaw(value)
        oldValue = toRaw(oldValue)
      }
      // 对象不是数组 && 旧值时 ref 值 && 新值不是 ref 值
      // 直接将新值赋值给旧值的 value 属性
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // 在浅响应模式中，无论值是否响应，都按原样设置
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 判断对象中是否存在该属性，进而判断 set 操作的类型是修改还是新增
    const hadKey =
      // 如果对象是数组 && key 是整数，则判断索引（key）和数组长度的大小，如果索引小于数组长度，则说明 key 存在，否则不存在
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        // 如果是对象，则通过 hasOwnProperty 判断对象是否存在 key
        : hasOwn(target, key)
    // 执行 set 的默认行为，并拿到执行结果
    const result = Reflect.set(target, key, value, receiver)

    /**
     * 如果对象是原型链中的某个数据，则不触发副作用执行
     * 主要为了解决如果情况：
     * const obj = {}, proto = { bar: 'parent bar value' }
     * const child = reactive(obj), parent = reactive(proto)
     * Object.setPrototypeOf(child, parent)
     * console.log(child.bar) // 读取时依赖收集，副作用和 child.bar 和 parent.bar 同时建立了联系
     * child.bar = 'child bar value' // 同样也会触发 parent 的 setter 方法，不合理，所以需要在 setter 中屏蔽原型链上的方法
     * // 这时候会发现 receiver 始终指向 child proxy，但两个 setter 中的 target 分别指向自己的 proxy（child 和 parent）的原始对象
     */
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      // 根据目标对象、key、操作类型（如果 key 不存在，则认为是新增操作，否则为修改操作），获取相关的副作用，然后触发这些副作用重新执行
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    // 返回 setter 操作的执行结果
    return result
  }
}

/**
 * 拦截对对象属性的删除操作，如果删除成功，调用 trigger 方法触发相关副作用重新执行
 * @param target 对象
 * @param key 操作的属性
 * @returns 
 */
function deleteProperty(target: object, key: string | symbol): boolean {
  // 判断对象是否有该属性
  const hadKey = hasOwn(target, key)
  // 旧值
  const oldValue = (target as any)[key]
  // 执行对象的删除操作
  const result = Reflect.deleteProperty(target, key)
  // 如果删除成功 && 对象也确实有该属性，则调用 trigger 方法触发相关副作用重新执行
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  // 返回执行结果
  return result
}

/**
 * 查看对象是否存在某属性，并进行依赖收集
 * @param target 目标对象
 * @param key 操作的属性
 * @returns 
 */
function has(target: object, key: string | symbol): boolean {
  // 查看对象是否存在该属性
  const result = Reflect.has(target, key)
  // 如果属性不是 Symbol 属性 || 内建的保留 Symbol 属性，则进行依赖收集
  // 这里主要是为了避免一些意外的错误和性能方面的考量，比如 for of 村还、Array.values 都会
  // 读取对象的迭代器属性，而这些属性没必要建立响应式联系
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

/**
 * 拦截获取对象自身键相关 API 的操作，进行依赖收集并返回由对象自身键组成的数组
 * @param target 目标对象
 * @returns 
 */
function ownKeys(target: object): (string | symbol)[] {
  // 依赖收集，操作类型为迭代类型（ITERATE），如果对象是数组，则依赖的 key 为 length，否则为 Symbol 值 ITERATE_KEY
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  // 返回由对象自身键组成的数组
  return Reflect.ownKeys(target)
}

// 普通对象的 proxy handler，方法具体能拦截哪些操作可以查看 https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy
export const mutableHandlers: ProxyHandler<object> = {
  // 拦截对对象的读取操作
  get,
  // 拦截对对象属性的设置操作
  set,
  // 拦截对对象属性的删除操作
  deleteProperty,
  // 对 in 操作符的代理
  has,
  // 拦截如下操作
  // Object.getOwnPropertyNames()
  // Object.getOwnPropertySymbols()
  // Object.keys()
  // Reflect.ownKeys()
  ownKeys
}

/**
 * 普通对象只读处理的 proxy handler，读取时不进行依赖收集，也不允许更改对象（set、delete）
 */
export const readonlyHandlers: ProxyHandler<object> = {
  // 只读 getter，不进行依赖收集
  get: readonlyGet,
  // 不允许进行 set（更改）操作
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  // 删除操作也不允许
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

/**
 * 浅响应式处理的 proxy handler，用浅响应式的 getter、setter 对象覆盖了默认的 handler 对象
 */
export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// 普通对象浅只读处理的 proxy handler
// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
