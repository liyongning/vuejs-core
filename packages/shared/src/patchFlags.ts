/**
 * Patch flags are optimization hints generated by the compiler.
 * when a block with dynamicChildren is encountered during diff, the algorithm
 * enters "optimized mode". In this mode, we know that the vdom is produced by
 * a render function generated by the compiler, so the algorithm only needs to
 * handle updates explicitly marked by these patch flags.
 *
 * Patch flags can be combined using the | bitwise operator and can be checked
 * using the & operator, e.g.
 *
 * ```js
 * const flag = TEXT | CLASS
 * if (flag & TEXT) { ... }
 * ```
 *
 * Check the `patchElement` function in '../../runtime-core/src/renderer.ts' to see how the
 * flags are handled during diff.
 * 
 * patchFlag 是编译器 generate 阶段的优化提示。
 * 当 diff 期间遇到了还有 dynamicChildren 属性的 block（就是含有 dynamicChildren 属性的虚拟 DOM），
 * diff 算法会进入优化模式。在这个模式下，我们知道 vdom 是由编译器生成的 render 函数产生的，算法只需要
 * 根据这些 patchFlag 标记进行更新，也就是说这些 patchFlag 指示 diff 算法在优化模式下如何高效的更新。
 * 
 * 可以使用位运算组合 patchFlag，然后使用 & 操作符去使用，例如：
 *
 * ```js
 * const flag = TEXT | CLASS
 * // 如果为 true，则标识节点是文本节点
 * if (flag & TEXT) { ... }
 * ```
 * 
 * 查看 '../../runtime-core/src/renderer.ts' 中的 patchElement 函数看 diff 期间如果处理这些 flag
 */
export const enum PatchFlags {
  /**
   * Indicates an element with dynamic textContent (children fast path)
   * 元素具有动态文本内容
   */
  TEXT = 1,

  /**
   * Indicates an element with dynamic class binding.
   * 元素具有有动态绑定的 class
   */
  CLASS = 1 << 1,

  /**
   * Indicates an element with dynamic style
   * The compiler pre-compiles static string styles into static objects
   * + detects and hoists inline static objects
   * e.g. `style="color: red"` and `:style="{ color: 'red' }"` both get hoisted
   * as:
   * 
   * 元素具有动态 style。
   * 编译器会将静态 style 字符串预编译为静态对象，检测并提升内联静态对象，比如：
   * `style="color: red"` and `:style="{ color: 'red' }"` 都会被提升，最终生成代码如下：
   * 
   * ```js
   * const style = { color: 'red' }
   * render() { return e('div', { style }) }
   * ```
   */
  STYLE = 1 << 2,

  /**
   * Indicates an element that has non-class/style dynamic props.
   * Can also be on a component that has any dynamic props (includes
   * class/style). when this flag is present, the vnode also has a dynamicProps
   * array that contains the keys of the props that may change so the runtime
   * can diff them faster (without having to worry about removed props)
   * 
   * 表示含有非 class、style 动态属性的元素，也可能是一个含有动态属性（包括 class、style）的组件。
   * 当此标志存在时，vnode 含有一个 dynamicProps 数组，数组包含所有可能会发生变化的属性的 key，
   * 因此在运行时可以快速的做 diff（不必担心删除属性）
   */
  PROPS = 1 << 3,

  /**
   * Indicates an element with props with dynamic keys. When keys change, a full
   * diff is always needed to remove the old key. This flag is mutually
   * exclusive with CLASS, STYLE and PROPS.
   * 表示属性含有动态 key 的元素。当 key 发生变化时，总是需要一个完整的 diff 来移除旧的 key。
   * 这个标志与上面的 PROP、STYLE、CLASS 标志互斥
   */
  FULL_PROPS = 1 << 4,

  /**
   * Indicates an element with event listeners (which need to be attached during hydration)
   * 表示需要在 hydration 期间添加事件监听器的元素
   */
  HYDRATE_EVENTS = 1 << 5,

  /**
   * Indicates a fragment whose children order doesn't change.
   * 表示子元素顺序不变的 Fragment
   */
  STABLE_FRAGMENT = 1 << 6,

  /**
   * Indicates a fragment with keyed or partially keyed children
   * 表示 Fragment 的子节点有 key 或 部分有 key
   */
  KEYED_FRAGMENT = 1 << 7,

  /**
   * Indicates a fragment with unkeyed children.
   * 表示 Fragment 的子节点没有 key
   */
  UNKEYED_FRAGMENT = 1 << 8,

  /**
   * Indicates an element that only needs non-props patching, e.g. ref or
   * directives (onVnodeXXX hooks). since every patched vnode checks for refs
   * and onVnodeXXX hooks, it simply marks the vnode so that a parent block
   * will track it.
   */
  NEED_PATCH = 1 << 9,

  /**
   * Indicates a component with dynamic slots (e.g. slot that references a v-for
   * iterated value, or dynamic slot names).
   * Components with this flag are always force updated.
   * 表示具有动态插槽的组件（比如：引用 v-for 迭代值 或 动态插槽名的插槽）。
   * 具有该标志的组件总是需要被强制更新
   */
  DYNAMIC_SLOTS = 1 << 10,

  /**
   * Indicates a fragment that was created only because the user has placed
   * comments at the root level of a template. This is a dev-only flag since
   * comments are stripped in production.
   * 该标志只在开发环境中出现，表示用户在模板的根节点处放了注释内容
   */
  DEV_ROOT_FRAGMENT = 1 << 11,

  /**
   * SPECIAL FLAGS -------------------------------------------------------------
   * Special flags are negative integers. They are never matched against using
   * bitwise operators (bitwise matching should only happen in branches where
   * patchFlag > 0), and are mutually exclusive. When checking for a special
   * flag, simply check patchFlag === FLAG.
   * 特殊 flag：
   * 这些 flag 是负数，他们不使用位运算进行匹配（位运算只发生在 patchFlag > 0 的时候），
   * 并且这些标志和其它标志互斥。当检查这些特殊标志的时候，只能：patchFlag === FLAG
   */

  /**
   * Indicates a hoisted static vnode. This is a hint for hydration to skip
   * the entire sub tree since static content never needs to be updated.
   * 表示一个已经静态提升过的 vnode。暗示在 hydration 期间跳过子树，因为静态内容永远不需要更新。
   */
  HOISTED = -1,
  /**
   * A special flag that indicates that the diffing algorithm should bail out
   * of optimized mode. For example, on block fragments created by renderSlot()
   * when encountering non-compiler generated slots (i.e. manually written
   * render functions, which should always be fully diffed)
   * OR manually cloneVNodes
   * 一个特殊标志，表示 diff 算法应该退出优化模式。比如：
   * 通过 renderSlot 创建的 block Fragment，遇到非编译器生成的插槽时，比如（手写的 render 函数，应该做完整的 diff），
   * 或者手动 克隆 vnode
   */
  BAIL = -2
}

/**
 * dev only flag -> name mapping
 */
export const PatchFlagNames = {
  [PatchFlags.TEXT]: `TEXT`,
  [PatchFlags.CLASS]: `CLASS`,
  [PatchFlags.STYLE]: `STYLE`,
  [PatchFlags.PROPS]: `PROPS`,
  [PatchFlags.FULL_PROPS]: `FULL_PROPS`,
  [PatchFlags.HYDRATE_EVENTS]: `HYDRATE_EVENTS`,
  [PatchFlags.STABLE_FRAGMENT]: `STABLE_FRAGMENT`,
  [PatchFlags.KEYED_FRAGMENT]: `KEYED_FRAGMENT`,
  [PatchFlags.UNKEYED_FRAGMENT]: `UNKEYED_FRAGMENT`,
  [PatchFlags.NEED_PATCH]: `NEED_PATCH`,
  [PatchFlags.DYNAMIC_SLOTS]: `DYNAMIC_SLOTS`,
  [PatchFlags.DEV_ROOT_FRAGMENT]: `DEV_ROOT_FRAGMENT`,
  [PatchFlags.HOISTED]: `HOISTED`,
  [PatchFlags.BAIL]: `BAIL`
}
