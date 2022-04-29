import {
  Text,
  Fragment,
  Comment,
  cloneIfMounted,
  normalizeVNode,
  VNode,
  VNodeArrayChildren,
  createVNode,
  isSameVNodeType,
  Static,
  VNodeHook,
  VNodeProps,
  invokeVNodeHook
} from './vnode'
import {
  ComponentInternalInstance,
  ComponentOptions,
  createComponentInstance,
  Data,
  setupComponent
} from './component'
import {
  filterSingleRoot,
  renderComponentRoot,
  shouldUpdateComponent,
  updateHOCHostEl
} from './componentRenderUtils'
import {
  EMPTY_OBJ,
  EMPTY_ARR,
  isReservedProp,
  PatchFlags,
  ShapeFlags,
  NOOP,
  invokeArrayFns,
  isArray,
  getGlobalThis
} from '@vue/shared'
import {
  queueJob,
  queuePostFlushCb,
  flushPostFlushCbs,
  invalidateJob,
  flushPreFlushCbs,
  SchedulerJob
} from './scheduler'
import { pauseTracking, resetTracking, ReactiveEffect } from '@vue/reactivity'
import { updateProps } from './componentProps'
import { updateSlots } from './componentSlots'
import { pushWarningContext, popWarningContext, warn } from './warning'
import { createAppAPI, CreateAppFunction } from './apiCreateApp'
import { setRef } from './rendererTemplateRef'
import {
  SuspenseBoundary,
  queueEffectWithSuspense,
  SuspenseImpl
} from './components/Suspense'
import { TeleportImpl, TeleportVNode } from './components/Teleport'
import { isKeepAlive, KeepAliveContext } from './components/KeepAlive'
import { registerHMR, unregisterHMR, isHmrUpdating } from './hmr'
import { createHydrationFunctions, RootHydrateFunction } from './hydration'
import { invokeDirectiveHook } from './directives'
import { startMeasure, endMeasure } from './profiling'
import {
  devtoolsComponentAdded,
  devtoolsComponentRemoved,
  devtoolsComponentUpdated,
  setDevtoolsHook
} from './devtools'
import { initFeatureFlags } from './featureFlags'
import { isAsyncWrapper } from './apiAsyncComponent'
import { isCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'

export interface Renderer<HostElement = RendererElement> {
  render: RootRenderFunction<HostElement>
  createApp: CreateAppFunction<HostElement>
}

export interface HydrationRenderer extends Renderer<Element | ShadowRoot> {
  hydrate: RootHydrateFunction
}

export type RootRenderFunction<HostElement = RendererElement> = (
  vnode: VNode | null,
  container: HostElement,
  isSVG?: boolean
) => void

export interface RendererOptions<
  HostNode = RendererNode,
  HostElement = RendererElement
> {
  patchProp(
    el: HostElement,
    key: string,
    prevValue: any,
    nextValue: any,
    isSVG?: boolean,
    prevChildren?: VNode<HostNode, HostElement>[],
    parentComponent?: ComponentInternalInstance | null,
    parentSuspense?: SuspenseBoundary | null,
    unmountChildren?: UnmountChildrenFn
  ): void
  insert(el: HostNode, parent: HostElement, anchor?: HostNode | null): void
  remove(el: HostNode): void
  createElement(
    type: string,
    isSVG?: boolean,
    isCustomizedBuiltIn?: string,
    vnodeProps?: (VNodeProps & { [key: string]: any }) | null
  ): HostElement
  createText(text: string): HostNode
  createComment(text: string): HostNode
  setText(node: HostNode, text: string): void
  setElementText(node: HostElement, text: string): void
  parentNode(node: HostNode): HostElement | null
  nextSibling(node: HostNode): HostNode | null
  querySelector?(selector: string): HostElement | null
  setScopeId?(el: HostElement, id: string): void
  cloneNode?(node: HostNode): HostNode
  insertStaticContent?(
    content: string,
    parent: HostElement,
    anchor: HostNode | null,
    isSVG: boolean,
    start?: HostNode | null,
    end?: HostNode | null
  ): [HostNode, HostNode]
}

// Renderer Node can technically be any object in the context of core renderer
// logic - they are never directly operated on and always passed to the node op
// functions provided via options, so the internal constraint is really just
// a generic object.
export interface RendererNode {
  [key: string]: any
}

export interface RendererElement extends RendererNode {}

// An object exposing the internals of a renderer, passed to tree-shakeable
// features so that they can be decoupled from this file. Keys are shortened
// to optimize bundle size.
export interface RendererInternals<
  HostNode = RendererNode,
  HostElement = RendererElement
> {
  p: PatchFn
  um: UnmountFn
  r: RemoveFn
  m: MoveFn
  mt: MountComponentFn
  mc: MountChildrenFn
  pc: PatchChildrenFn
  pbc: PatchBlockChildrenFn
  n: NextFn
  o: RendererOptions<HostNode, HostElement>
}

// These functions are created inside a closure and therefore their types cannot
// be directly exported. In order to avoid maintaining function signatures in
// two places, we declare them once here and use them inside the closure.
type PatchFn = (
  n1: VNode | null, // null means this is a mount
  n2: VNode,
  container: RendererElement,
  anchor?: RendererNode | null,
  parentComponent?: ComponentInternalInstance | null,
  parentSuspense?: SuspenseBoundary | null,
  isSVG?: boolean,
  slotScopeIds?: string[] | null,
  optimized?: boolean
) => void

type MountChildrenFn = (
  children: VNodeArrayChildren,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  start?: number
) => void

type PatchChildrenFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean
) => void

type PatchBlockChildrenFn = (
  oldChildren: VNode[],
  newChildren: VNode[],
  fallbackContainer: RendererElement,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null
) => void

type MoveFn = (
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  type: MoveType,
  parentSuspense?: SuspenseBoundary | null
) => void

type NextFn = (vnode: VNode) => RendererNode | null

type UnmountFn = (
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean
) => void

type RemoveFn = (vnode: VNode) => void

type UnmountChildrenFn = (
  children: VNode[],
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  optimized?: boolean,
  start?: number
) => void

export type MountComponentFn = (
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean
) => void

type ProcessTextOrCommentFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null
) => void

export type SetupRenderEffectFn = (
  instance: ComponentInternalInstance,
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean
) => void

export const enum MoveType {
  ENTER,
  LEAVE,
  REORDER
}

export const queuePostRenderEffect = __FEATURE_SUSPENSE__
  ? queueEffectWithSuspense
  : queuePostFlushCb

/**
 * The createRenderer function accepts two generic arguments:
 * HostNode and HostElement, corresponding to Node and Element types in the
 * host environment. For example, for runtime-dom, HostNode would be the DOM
 * `Node` interface and HostElement would be the DOM `Element` interface.
 *
 * Custom renderers can pass in the platform specific types like this:
 *
 * ``` js
 * const { render, createApp } = createRenderer<Node, Element>({
 *   patchProp,
 *   ...nodeOps
 * })
 * ```
 * 创建渲染器
 */
export function createRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement
>(options: RendererOptions<HostNode, HostElement>) {
  return baseCreateRenderer<HostNode, HostElement>(options)
}

// Separate API for creating hydration-enabled renderer.
// Hydration logic is only used when calling this function, making it
// tree-shakable.
export function createHydrationRenderer(
  options: RendererOptions<Node, Element>
) {
  return baseCreateRenderer(options, createHydrationFunctions)
}

// overload 1: no hydration
function baseCreateRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement>

// overload 2: with hydration
function baseCreateRenderer(
  options: RendererOptions<Node, Element>,
  createHydrationFns: typeof createHydrationFunctions
): HydrationRenderer

/**
 * implementation
 * 渲染器的具体实现
 * @param options 渲染选项，由 runtime-dom 提供（渲染器的调用者）
 * @param createHydrationFns 同构应用会传递该参数
 * @returns 
 */
function baseCreateRenderer(
  options: RendererOptions,
  createHydrationFns?: typeof createHydrationFunctions
): any {
  // compile-time feature flags check
  if (__ESM_BUNDLER__ && !__TEST__) {
    initFeatureFlags()
  }

  const target = getGlobalThis()
  target.__VUE__ = true
  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    setDevtoolsHook(target.__VUE_DEVTOOLS_GLOBAL_HOOK__, target)
  }

  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    cloneNode: hostCloneNode,
    insertStaticContent: hostInsertStaticContent
  } = options

  /**
   * Note: functions inside this closure should use `const xxx = () => {}`
   * style in order to prevent being inlined by minifiers.
   * 将 vnode（文本节点、注释节点、静态节点、Fragment、普通元素、组件、TELEPORT、SUSPENSE） 渲染为真实 DOM
   * 如果 old vnode 存在，则执行更新操作
   * 如果 old vnode 不存在，则执行挂载操作
   * @param n1 旧的 vnode
   * @param n2 新的 vnode
   * @param container 容器节点
   * @param anchor 参考节点，比如 container.insertBefore(node, anchor)
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 是否开启优化，开发环境 && 热更新时不开启，否则如果有 dynamicChildren（block tree）则开启优化
   * @returns 
   */
  const patch: PatchFn = (
    n1,
    n2,
    container,
    anchor = null,
    parentComponent = null,
    parentSuspense = null,
    isSVG = false,
    slotScopeIds = null,
    // 是否开启优化，开发环境 && 热更新时不开启，否则如果有 dynamicChildren（block tree）则开启优化
    optimized = __DEV__ && isHmrUpdating ? false : !!n2.dynamicChildren
  ) => {
    // 新旧节点相同，则直接返回
    // patch 会被递归调用，是递归的终止条件
    if (n1 === n2) {
      return
    }

    // patching & not same type, unmount old tree
    // 如果发现新旧 vnode 类型不同，则直接卸载掉旧的 vnode，新的 vnode 走初始化挂载流程
    // 更新操作只能发生在同类型的节点上
    if (n1 && !isSameVNodeType(n1, n2)) {
      anchor = getNextHostNode(n1)
      unmount(n1, parentComponent, parentSuspense, true)
      n1 = null
    }

    // 是否需要退出 diff 算法优化模式
    // 比如遇到用户手写的 render 函数，则会推出优化模式，所以，该优化只针对编译器生成的 render 函数起作用
    if (n2.patchFlag === PatchFlags.BAIL) {
      optimized = false
      n2.dynamicChildren = null
    }

    // 不同类型的节点走不同的处理流程
    // 分别处理文本节点、注释节点、静态节点、Fragment 节点、元素节点、组件节点、TELEPORT 节点、SUSPENSE 节点
    const { type, ref, shapeFlag } = n2
    switch (type) {
      // 处理文本节点的挂载、更新
      case Text:
        processText(n1, n2, container, anchor)
        break
      // 处理注释节点的挂载、更新
      case Comment:
        processCommentNode(n1, n2, container, anchor)
        break
      // 处理静态节点
      case Static:
        if (n1 == null) {
          // 旧的 vnode 不存在，则挂载 n2，内部直接使用 innerHTML 设置到页面上
          mountStaticNode(n2, container, anchor, isSVG)
        } else if (__DEV__) {
          //  静态节点的更新只用于开发期间的热更新，线上不存在该情况（静态节点不存在更新的情况）
          patchStaticNode(n1, n2, container, isSVG)
        }
        break
      // 处理片段节点，即多根节点
      // 如果 old vnode 不存在，调用 mountChildren 方法，遍历片段的子元素列表，递归调用 patch 方法依次挂载每个元素
      // 如果 old vnode 存在，则执行更新操作（block 更新 或 全量 diff 更新）
      case Fragment:
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        break
      default:
        if (shapeFlag & ShapeFlags.ELEMENT) {
          // 处理普通元素的挂载、更新
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else if (shapeFlag & ShapeFlags.COMPONENT) {
          // 处理组件的初始化挂载和后续的被动更新
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else if (shapeFlag & ShapeFlags.TELEPORT) {
          // teleport 组件，直接执行组件的 process 方法进行挂载和更新
          // teleport 组件和渲染的底层紧密相连，在 process 内部借用了部分渲染器的底层能力
          ;(type as typeof TeleportImpl).process(
            n1 as TeleportVNode,
            n2 as TeleportVNode,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized,
            internals
          )
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
          // 同 teleport，具体的实现可以单独开一个模块去讲解
          ;(type as typeof SuspenseImpl).process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized,
            internals
          )
        } else if (__DEV__) {
          warn('Invalid VNode type:', type, `(${typeof type})`)
        }
    }

    // 通过 ref 属性访问元素（普通元素的 DOM 节点、组件的实例）
    // set ref
    if (ref != null && parentComponent) {
      setRef(ref, n1 && n1.ref, parentSuspense, n2 || n1, !n2)
    }
  }

  /**
   * 处理文本节点，具体的操作是通过创建渲染器时提供的 DOM API 来完成的
   * 如果 旧的 vnode 不存在，则在指定位置创建新的文本节点
   * 如果 新旧 vnode 都存在，则更新旧的 vnode 的文本内容
   */
  const processText: ProcessTextOrCommentFn = (n1, n2, container, anchor) => {
    if (n1 == null) {
      // 老的 vnode 不存在，新的 vnode 走初始化挂载流程
      // 方法是由 runtime-dom 创建渲染器时提供的，其实就是具体的 dom 操作 api
      // 对应到浏览器中的方法就是 parent.insertBefore(childNode, anchor)
      hostInsert(
        // 创建文本节点
        (n2.el = hostCreateText(n2.children as string)),
        // 容器节点
        container,
        // 参考节点
        anchor
      )
    } else {
      // 更新节点，如果新旧节点的文本内容（子节点）不同，则用新的文本内容更新旧节点的 文本
      const el = (n2.el = n1.el!)
      if (n2.children !== n1.children) {
        hostSetText(el, n2.children as string)
      }
    }
  }

  /**
   * 处理注释节点的挂载、更新（注释节点不支持动态数据，不存在更新情况） 
   */
  const processCommentNode: ProcessTextOrCommentFn = (
    n1,
    n2,
    container,
    anchor
  ) => {
    if (n1 == null) {
      // 初始化挂载注释节点
      // 创建注释节点，然后插入到指定位置
      hostInsert(
        (n2.el = hostCreateComment((n2.children as string) || '')),
        container,
        anchor
      )
    } else {
      // 注释节点不支持动态数据，不存在更新的情况，直接将 oldvnode.el 给 newvnode.el 即可
      // there's no support for dynamic comments
      n2.el = n1.el
    }
  }

  /**
   * 挂载静态节点
   * 静态节点一般只在 compiler-dom 和 runtime-dom 一起使用时存在
   * 因为静态节点是由编译器生成并标记出来的，而且也只有这种情况下才能安全使用
   * 因为静态节点是直接使用 innerHTML 设置到页面
   */
  const mountStaticNode = (
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    isSVG: boolean
  ) => {
    // static nodes are only present when used with compiler-dom/runtime-dom
    // which guarantees presence of hostInsertStaticContent.
    ;[n2.el, n2.anchor] = hostInsertStaticContent!(
      n2.children as string,
      container,
      anchor,
      isSVG,
      n2.el,
      n2.anchor
    )
  }

  /**
   * Dev / HMR only
   * 静态节点的更新只用于开发期间的热更新，线上不存在该情况（静态节点不存在更新的情况）
   */
  const patchStaticNode = (
    n1: VNode,
    n2: VNode,
    container: RendererElement,
    isSVG: boolean
  ) => {
    // static nodes are only patched during dev for HMR
    // 如果新旧节点不同，则移除旧节点，然后插入新节点
    if (n2.children !== n1.children) {
      const anchor = hostNextSibling(n1.anchor!)
      // remove existing
      removeStaticNode(n1)
      // insert new
      ;[n2.el, n2.anchor] = hostInsertStaticContent!(
        n2.children as string,
        container,
        anchor,
        isSVG
      )
    } else {
      // 如果新旧节点的子节点一样，则直接更新 vnode 上对应的真实 DOM
      n2.el = n1.el
      n2.anchor = n1.anchor
    }
  }

  const moveStaticNode = (
    { el, anchor }: VNode,
    container: RendererElement,
    nextSibling: RendererNode | null
  ) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el)
      hostInsert(el, container, nextSibling)
      el = next
    }
    hostInsert(anchor!, container, nextSibling)
  }

  const removeStaticNode = ({ el, anchor }: VNode) => {
    let next
    while (el && el !== anchor) {
      next = hostNextSibling(el)
      hostRemove(el)
      el = next
    }
    hostRemove(anchor!)
  }

  /**
   * 处理普通元素的挂载、更新，即 html 标签
   * @param n1 old vnode
   * @param n2 new vnode
   * @param container 
   * @param anchor 
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const processElement = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    isSVG = isSVG || (n2.type as string) === 'svg'
    if (n1 == null) {
      // old vnode 不存在，执行普通元素的初始化挂载
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    } else {
      // 新旧 vnode 都存在，则更新 DOM 元素中发生变化的属性和文本。
      patchElement(
        n1,
        n2,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    }
  }

  /**
   * 挂载元素
   * 1、创建元素本身
   * 2、调用 mountChildren 递归的创建该元素的子元素，并追加到当前元素上
   * 3、执行指令的 created 钩子函数（如果存在的话）
   * 4、设置该元素的众多属性，比如 class、style、事件等
   * 5、在元素添加到容器节点上之前，执行一些钩子，比如：指令的 beforeMount、transition 的 beforeEnter
   * 6、将元素添加到容器节点上，这一步完成之后在页面上就能看到该元素了
   * 7、元素追加之后，通过 queuePostRenderEffect 方法在队列中放一个回调，负责执行一些钩子，比如：transition.enter、指令的 mounted，回调会在组件渲染函数之后执行
   * @param vnode 需要被挂载元素的 vnode
   * @param container 容器元素
   * @param anchor 参考元素
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const mountElement = (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    let el: RendererElement
    let vnodeHook: VNodeHook | undefined | null
    const { type, props, shapeFlag, transition, patchFlag, dirs } = vnode
    if (
      !__DEV__ &&
      vnode.el &&
      hostCloneNode !== undefined &&
      patchFlag === PatchFlags.HOISTED
    ) {
      // If a vnode has non-null el, it means it's being reused.
      // Only static vnodes can be reused, so its mounted DOM nodes should be
      // exactly the same, and we can simply do a clone here.
      // only do this in production since cloned trees cannot be HMR updated.
      // 挂载阶段发现 vnode.el 存在，则说明这是一个正在被重复使用的静态节点，所以它的挂载节点应该
      // 是一样的，则直接 clone 它，当然，该操作也只在生产环境下进行
      el = vnode.el = hostCloneNode(vnode.el)
    } else {
      // 调用 createElement API 创建元素，并将 DOM 元素添加到 vnode.el 上，下次更新时会用到，
      // vnode.el 的作用主要是做真实 DOM 和 vnode 之间的对应
      el = vnode.el = hostCreateElement(
        vnode.type as string,
        isSVG,
        props && props.is,
        props
      )

      // 元素本身创建完成后，接下来先创建 vnode.el 的子元素，vnode.el 的子元素先于属性处理，
      // 因为元素的某些属性依赖已经渲染的子元素，比如 select 标签的 value 属性
      // mount children first, since some props may rely on child content
      // being already rendered, e.g. `<select value>`
      if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
        // 子元素是文本，则直接设置，el.textContent = text_content
        hostSetElementText(el, vnode.children as string)
      } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // vnode.el 有一组子元素，则调用 mountChildren 方法，循环遍历这些子元素，
        // 调用 patch 方法递归的依次创建这些子元素
        mountChildren(
          vnode.children as VNodeArrayChildren,
          el,
          null,
          parentComponent,
          parentSuspense,
          isSVG && type !== 'foreignObject',
          slotScopeIds,
          optimized
        )
      }

      // 处理指令，在创建阶段则是执行指令的 created 钩子函数
      if (dirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'created')
      }
      // props
      // 处理属性，比如 class、style、事件等，
      // 具体的处理方法在 runtime-dom/src/patchProp.ts 中，方法也是在创建渲染器时传递进来的
      if (props) {
        // 非 value 属性 和 保留属性
        for (const key in props) {
          if (key !== 'value' && !isReservedProp(key)) {
            hostPatchProp(
              el,
              key,
              null,
              props[key],
              isSVG,
              vnode.children as VNode[],
              parentComponent,
              parentSuspense,
              unmountChildren
            )
          }
        }
        /**
         * Special case for setting value on DOM elements:
         * - it can be order-sensitive (e.g. should be set *after* min/max, #2325, #4024)
         * - it needs to be forced (#1471)
         * #2353 proposes adding another renderer option to configure this, but
         * the properties affects are so finite it is worth special casing it
         * here to reduce the complexity. (Special casing it also should not
         * affect non-DOM renderers)
         * 
         * 把 value 属性单独拎出来，主要是为了解决一些特殊情况，不过本质还是在元素上设置属性和值
         */
        if ('value' in props) {
          hostPatchProp(el, 'value', null, props.value)
        }
        // vnode 上可能有一些需要在 挂载前 执行的 hook 方法，但具体是什么，暂时还不清楚
        if ((vnodeHook = props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parentComponent, vnode)
        }
      }
      // scopeId
      setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent)
    }
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      Object.defineProperty(el, '__vnode', {
        value: vnode,
        enumerable: false
      })
      Object.defineProperty(el, '__vueParentComponent', {
        value: parentComponent,
        enumerable: false
      })
    }
    // 执行指令的 beforeMount 钩子函数
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
    }
    // 如果有需要执行的 transition hook，则挂载阶段执行 其 beforeEnter hook 方法
    // #1583 For inside suspense + suspense not resolved case, enter hook should call when suspense resolved
    // #1689 For inside suspense + suspense resolved case, just call it
    const needCallTransitionHooks =
      (!parentSuspense || (parentSuspense && !parentSuspense.pendingBranch)) &&
      transition &&
      !transition.persisted
    if (needCallTransitionHooks) {
      transition!.beforeEnter(el)
    }
    // 元素、子元素创建完成，以及对应的属性也都设置好了以后，则将元素插入到容器节点内的指定位置
    hostInsert(el, container, anchor)
    // 在元素渲染完成之后，在队列中放一个待执行的方法，该方法负责执行一些 hook，比如：
    // transition.enter、指令的 mounted 钩子
    if (
      (vnodeHook = props && props.onVnodeMounted) ||
      needCallTransitionHooks ||
      dirs
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        needCallTransitionHooks && transition!.enter(el)
        dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
      }, parentSuspense)
    }
  }

  const setScopeId = (
    el: RendererElement,
    vnode: VNode,
    scopeId: string | null,
    slotScopeIds: string[] | null,
    parentComponent: ComponentInternalInstance | null
  ) => {
    if (scopeId) {
      hostSetScopeId(el, scopeId)
    }
    if (slotScopeIds) {
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i])
      }
    }
    if (parentComponent) {
      let subTree = parentComponent.subTree
      if (
        __DEV__ &&
        subTree.patchFlag > 0 &&
        subTree.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT
      ) {
        subTree =
          filterSingleRoot(subTree.children as VNodeArrayChildren) || subTree
      }
      if (vnode === subTree) {
        const parentVNode = parentComponent.vnode
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent
        )
      }
    }
  }

  /**
   * 循环遍历元素列表，递归调用 patch 方法创建每个元素
   * @param children 需要被挂载的一组元素（数组）
   * @param container 容器元素
   * @param anchor 参考元素
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   * @param start 指定 children 开始遍历的位置
   */
  const mountChildren: MountChildrenFn = (
    children,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    slotScopeIds,
    optimized,
    start = 0
  ) => {
    // 循环遍历元素列表，递归的调用 patch 方法创建每个元素
    for (let i = start; i < children.length; i++) {
      const child = (children[i] = optimized
        ? cloneIfMounted(children[i] as VNode)
        : normalizeVNode(children[i]))
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    }
  }

  /**
   * 更新 DOM 元素中发生变化的属性和文本。出于优化考虑，DOM 元素中尽量不要以动态 key 作为属性，这会导致全量 diff props 对象
   * @param n1 old vnode
   * @param n2 new vnode
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const patchElement = (
    n1: VNode,
    n2: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // 同步 vnode 对应的真是 DOM，不然下次无法正常更新，因为找到 vnode 对应的真实 DOM
    const el = (n2.el = n1.el!)
    // patchFlag、block tree、指令
    let { patchFlag, dynamicChildren, dirs } = n2
    // #1426 take the old vnode's patch flag into account since user may clone a
    // compiler-generated vnode, which de-opts to FULL_PROPS
    patchFlag |= n1.patchFlag & PatchFlags.FULL_PROPS
    // 新旧 props
    const oldProps = n1.props || EMPTY_OBJ
    const newProps = n2.props || EMPTY_OBJ
    let vnodeHook: VNodeHook | undefined | null

    // disable recurse in beforeUpdate hooks
    // 在执行 beforeUpdate 钩子期间禁止递归
    parentComponent && toggleRecurse(parentComponent, false)
    if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
    }
    // 执行指令的 beforeUpdate 钩子
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate')
    }
    parentComponent && toggleRecurse(parentComponent, true)

    // 开发环境下强制全量 diff
    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    const areChildrenSVG = isSVG && n2.type !== 'foreignObject'
    if (dynamicChildren) {
      // 存在 block tree，遍历 block 数组，递归调用 patch，依次更新数组中的每个 vnode
      patchBlockChildren(
        n1.dynamicChildren!,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        areChildrenSVG,
        slotScopeIds
      )
      // 针对开发环境的热更新和含有 v-for 指令的 template fragment。
      // 将所有子节点的 oldVNode.el 同步到 newVNode.el 上，以确保子节点可以被正常更新
      if (__DEV__ && parentComponent && parentComponent.type.__hmrId) {
        traverseStaticChildren(n1, n2)
      }
    } else if (!optimized) {
      // full diff
      // 没有 block tree，通过全量 diff 进行更新
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        areChildrenSVG,
        slotScopeIds,
        false
      )
    }

    if (patchFlag > 0) {
      // the presence of a patchFlag means this element's render code was
      // generated by the compiler and can take the fast path.
      // in this path old node and new node are guaranteed to have the same shape
      // (i.e. at the exact same position in the source template)
      // patchFlag 的存在，意味着元素的渲染函数代码是编译器生成的，可以走快速更新路径进行定向更新。
      // 在该路径下新旧 vnode 具有同样的结构，比如在模板字符串中的位置是一样的。

      if (patchFlag & PatchFlags.FULL_PROPS) {
        // element props contain dynamic keys, full diff needed
        // 元素属性中含有动态 key （比如：<div :[key]="{ color }"></div>），则全量 diff props 对象，更新 DOM 元素上发生变化的属性
        patchProps(
          el,
          n2,
          oldProps,
          newProps,
          parentComponent,
          parentSuspense,
          isSVG
        )
      } else {
        // 这里会进行定向更新

        // class
        // this flag is matched when the element has dynamic class bindings.
        // 动态 class 绑定，比如：<div :class="test"></div>
        if (patchFlag & PatchFlags.CLASS) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, 'class', null, newProps.class, isSVG)
          }
        }

        // style
        // this flag is matched when the element has dynamic style bindings
        // 动态 style 绑定，比如：<div :style="test"></div>
        if (patchFlag & PatchFlags.STYLE) {
          hostPatchProp(el, 'style', oldProps.style, newProps.style, isSVG)
        }

        // props
        // This flag is matched when the element has dynamic prop/attr bindings
        // other than class and style. The keys of dynamic prop/attrs are saved for
        // faster iteration.
        // Note dynamic keys like :[foo]="bar" will cause this optimization to
        // bail out and go through a full diff because we need to unset the old key
        if (patchFlag & PatchFlags.PROPS) {
          // 含有 非动态 class、style 属性的元素，会走到这里，比如 <div :test="bar"></div>
          // if the flag is present then dynamicProps must be non-null
          const propsToUpdate = n2.dynamicProps!
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i]
            const prev = oldProps[key]
            const next = newProps[key]
            // #1471 force patch value
            if (next !== prev || key === 'value') {
              hostPatchProp(
                el,
                key,
                prev,
                next,
                isSVG,
                n1.children as VNode[],
                parentComponent,
                parentSuspense,
                unmountChildren
              )
            }
          }
        }
      }

      // text
      // This flag is matched when the element has only dynamic text children.
      // 更新元素的文本节点
      if (patchFlag & PatchFlags.TEXT) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children as string)
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      // unoptimized, full diff
      patchProps(
        el,
        n2,
        oldProps,
        newProps,
        parentComponent,
        parentSuspense,
        isSVG
      )
    }

    // 如果存在指令，则将指令的 updated 钩子放入队列，待更新完成后执行
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
        dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated')
      }, parentSuspense)
    }
  }

  /**
   * The fast path for blocks.
   * 基于 block 的快速更新路径，区别于 Vue 的全量 diff，Vue3 只需要 diff 模板中所有的 动态节点，
   * 这些动态节点都存放在 vnode.dynamicChildren 对象中，形成了一棵 block tree。
   * 
   * 遍历 block 数组，递归调用 patch，依次更新数组中的每个 vnode
   * @param oldChildren 旧的 block 数组
   * @param newChildren 新的 block 数组
   * @param fallbackContainer 容器节点
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   */
  const patchBlockChildren: PatchBlockChildrenFn = (
    oldChildren,
    newChildren,
    fallbackContainer,
    parentComponent,
    parentSuspense,
    isSVG,
    slotScopeIds
  ) => {
    // 遍历新的 block 数组
    for (let i = 0; i < newChildren.length; i++) {
      // 旧的 vnode
      const oldVNode = oldChildren[i]
      // 新的 vnode
      const newVNode = newChildren[i]
      // 确定容器节点
      // Determine the container (parent element) for the patch.
      const container =
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        oldVNode.el &&
        // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        (oldVNode.type === Fragment ||
          // - In the case of different nodes, there is going to be a replacement
          // which also requires the correct parent container
          !isSameVNodeType(oldVNode, newVNode) ||
          // - In the case of a component, it could contain anything.
          oldVNode.shapeFlag & (ShapeFlags.COMPONENT | ShapeFlags.TELEPORT))
          ? hostParentNode(oldVNode.el)!
          : // In other cases, the parent container is not actually used so we
            // just pass the block element here to avoid a DOM parentNode call.
            fallbackContainer
      // 递归调用 patch，更新新旧 vnode
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        true
      )
    }
  }

  /**
   * 全量 diff props 对象，更新 DOM 元素上发生变化的属性
   * @param el vnode 对应的 DOM 元素
   * @param vnode new vnode
   * @param oldProps 旧的 props
   * @param newProps 新的 props
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   */
  const patchProps = (
    el: RendererElement,
    vnode: VNode,
    oldProps: Data,
    newProps: Data,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean
  ) => {
    // 如果新旧 props 对象不相等
    if (oldProps !== newProps) {
      // 遍历新的 props 对象
      for (const key in newProps) {
        // empty string is not valid prop
        // 不处理 保留属性
        if (isReservedProp(key)) continue
        // 拿到 props[key] 的新旧值
        const next = newProps[key]
        const prev = oldProps[key]
        // 如果新旧值不同，则更新
        // hostPatchProp 是 runtime-dom 提供的方法，在 runtime-dom/src/patchProps.ts 中
        // 负责更新 DOM 元素上的 class、style、事件等属性
        // defer patching value
        if (next !== prev && key !== 'value') {
          hostPatchProp(
            el,
            key,
            prev,
            next,
            isSVG,
            vnode.children as VNode[],
            parentComponent,
            parentSuspense,
            unmountChildren
          )
        }
      }
      // 删除 DOM 元素上那些已经不在 newProps 对象上的属性
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              isSVG,
              vnode.children as VNode[],
              parentComponent,
              parentSuspense,
              unmountChildren
            )
          }
        }
      }
      // 设置 DOM 元素的 value 属性
      if ('value' in newProps) {
        hostPatchProp(el, 'value', oldProps.value, newProps.value)
      }
    }
  }

  /**
   * 处理 Fragment
   * 1、如果 旧的 vnode 不存在，则挂载 新的 vnode（n2）上的所有子元素，
   *   在 mountChildren 方法中遍历子元素列表，递归调用 patch 方法依次挂载每个元素
   * 2、如果 旧的 vnode 存在，则执行更新操作（block 更新 或 全量 diff 更新）
   * @param n1 old vnode
   * @param n2 new vnode
   * @param container 容器节点
   * @param anchor 
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const processFragment = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // 创建两个锚点元素，都是空的文本元素
    const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''))!
    const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''))!

    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2

    // 开发环境下的热更新，关闭 diff 优化
    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // check if this is a slot fragment with :slotted scope ids
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds
        ? slotScopeIds.concat(fragmentSlotScopeIds)
        : fragmentSlotScopeIds
    }

    if (n1 == null) {
      // old vnode 不存在，进行初始挂载
      hostInsert(fragmentStartAnchor, container, anchor)
      hostInsert(fragmentEndAnchor, container, anchor)
      // a fragment can only have array children
      // since they are either generated by the compiler, or implicitly created
      // from arrays.
      // 挂载片段上的所有子元素
      // 片段的子元素只能是数组，这些子元素要么是通过编译器生成，要不是通过数组元素直接创建
      mountChildren(
        n2.children as VNodeArrayChildren,
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    } else {
      // old vnode 存在，执行后续更新
      // 对于 block 节点，遍历 dynamicChildren 数组，递归调用 patch，依次更新数组中的每个 vnode，
      // 而对于非 block 节点，则通过全量 diff 进行更新
      if (
        patchFlag > 0 &&
        patchFlag & PatchFlags.STABLE_FRAGMENT &&
        dynamicChildren &&
        // #2715 the previous fragment could've been a BAILed one as a result
        // of renderSlot() with no valid children
        n1.dynamicChildren
      ) {
        // a stable fragment (template root or <template v-for>) doesn't need to
        // patch children order, but it may contain dynamicChildren.
        // 一个稳定的 fragment (比如 根节点或 v-for 节点)不需要 patch 子节点的顺序，但是这些节点可能包含 dynamicChildren 对象。
        // 所以这里处理的是 block 节点的更新，即 vnode.dynamicChildren 中存储的所有动态节点
        // 遍历 block 数组，递归调用 patch，依次更新数组中的每个 vnode
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds
        )
        // 针对开发环境的热更新和含有 v-for 指令的 template fragment。
        // 将所有子节点的 oldVNode.el 同步到 newVNode.el 上，以确保子节点可以被正常更新
        if (__DEV__ && parentComponent && parentComponent.type.__hmrId) {
          traverseStaticChildren(n1, n2)
        } else if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          n2.key != null ||
          (parentComponent && n2 === parentComponent.subTree)
        ) {
          traverseStaticChildren(n1, n2, true /* shallow */)
        }
      } else {
        // keyed / unkeyed, or manual fragments.
        // for keyed & unkeyed, since they are compiler generated from v-for,
        // each child is guaranteed to be a block so the fragment will never have dynamicChildren.

        // 没有 dynamicChildren 属性就会走到这里，通过全量 diff 进行 patch
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
      }
    }
  }

  /**
   * 处理组件的初始化挂载和后续的被动更新。当父组件的响应式状态发生改变后，触发副作用，执行 render 函数，重新生成 vnode，
   * 然后进行 patch，当 patch 到某个 vnode 是组件类型时，就会走到这里。
   * 组件的自更新不会走这里，当组件自身的响应式状态发生改变后，直接触发自己的副作用，执行 render 函数，进行 patch。
   * @param n1 old vnode
   * @param n2 new vnode
   * @param container 
   * @param anchor 
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const processComponent = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    n2.slotScopeIds = slotScopeIds
    if (n1 == null) {
      // 老的 vnode 不存在，则执行挂载
      if (n2.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) {
        // 如果是被 keep-alive 组件包裹的组件，则执行激活操作，不走更新流程
        ;(parentComponent!.ctx as KeepAliveContext).activate(
          n2,
          container,
          anchor,
          isSVG,
          optimized
        )
      } else {
        // 挂载组件
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
      }
    } else {
      // 新旧 vnode 都存在，则更新组件。
      // 如果组件需要更新则执行组件实例上的 update 方法进行更新（触发副作用执行），如果不需要则简单的拷贝属性即可。
      updateComponent(n1, n2, optimized)
    }
  }

  /**
   * 挂载组件
   * 1、创建组件实例，就一个大对象，组件的相关属性都在上面
   * 2、如果组件被 keep-alive 包裹，则注入内部渲染器，keep-alive 有自己的渲染逻辑
   * 3、处理组件的所有 options 配置
   * 4、异步的 setup 和 suspense
   * 5、设置渲染副作用，完成组件的初始挂载 和 后续响应式更新的设置
   * @param initialVNode 组件 vnode
   * @param container 容器元素
   * @param anchor 参考元素
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param optimized 
   * @returns 
   */
  const mountComponent: MountComponentFn = (
    initialVNode,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    optimized
  ) => {
    // 2.x compat may pre-create the component instance before actually mounting
    // Vue2 兼容处理，可能会在组件实际挂载前预创建组件实例
    const compatMountInstance =
      __COMPAT__ && initialVNode.isCompatRoot && initialVNode.component
    // 总之，这块儿就是在创建组件实例，就是一个大对象，和组件相关的属性都会放到该对象上
    const instance: ComponentInternalInstance =
      compatMountInstance ||
      (initialVNode.component = createComponentInstance(
        initialVNode,
        parentComponent,
        parentSuspense
      ))

    if (__DEV__ && instance.type.__hmrId) {
      registerHMR(instance)
    }

    if (__DEV__) {
      pushWarningContext(initialVNode)
      startMeasure(instance, `mount`)
    }

    // 为 keep-alive 包裹的组件注入内部渲染器，keep-alive 有自己独特的渲染逻辑
    // inject renderer internals for keepAlive
    if (isKeepAlive(initialVNode)) {
      ;(instance.ctx as KeepAliveContext).renderer = internals
    }

    // 处理组件的所有 options 配置，比如 props、setup、inject、data、methods、computed、watch、provide 生命周期等
    // 也可以算是响应式 API 的一个入口
    // resolve props and slots for setup context
    if (!(__COMPAT__ && compatMountInstance)) {
      if (__DEV__) {
        startMeasure(instance, `init`)
      }
      setupComponent(instance)
      if (__DEV__) {
        endMeasure(instance, `init`)
      }
    }

    // setup() is async. This component relies on async logic to be resolved before proceeding
    // 如果 setup 是异步的，则组件在继续之前依赖于要解析的异步逻辑，配合 suspense 组件使用
    if (__FEATURE_SUSPENSE__ && instance.asyncDep) {
      parentSuspense && parentSuspense.registerDep(instance, setupRenderEffect)

      // Give it a placeholder if this is not hydration
      // TODO handle self-defined fallback
      if (!initialVNode.el) {
        const placeholder = (instance.subTree = createVNode(Comment))
        processCommentNode(null, placeholder, container!, anchor)
      }
      return
    }

    // 设置渲染副作用，负责初始化挂载和后续更新（当组件响应式数据更新后，触发组件更新函数重新执行）
    setupRenderEffect(
      instance,
      initialVNode,
      container,
      anchor,
      parentSuspense,
      isSVG,
      optimized
    )

    if (__DEV__) {
      popWarningContext()
      endMeasure(instance, `mount`)
    }
  }

  /**
   * 更新组件。如果组件需要更新则执行组件实例上的 update 方法进行更新（触发副作用执行），如果不需要则简单的拷贝属性即可。
   * @param n1 old vnode
   * @param n2 new vnode
   * @param optimized 优化模式
   * @returns 
   */
  const updateComponent = (n1: VNode, n2: VNode, optimized: boolean) => {
    const instance = (n2.component = n1.component)!
    // 判断组件是否应该更新
    //  1. 开发环境下，只要父组件更新了，子组件就更新
    //  2. newVNode 存在运行时指令或转换，子组件就更新
    //  3. 如果存在动态插槽则更新
    //  4. 如果新旧 props 对象或 props[key] 对应的值发生了改变，则更新
    if (shouldUpdateComponent(n1, n2, optimized)) {
      if (
        __FEATURE_SUSPENSE__ &&
        instance.asyncDep &&
        !instance.asyncResolved
      ) {
        // 如果是异步组件并且仍然处于 pending 状态，则只更新 props 和 slots，
        // 因为组件的响应式副作用还没执行完。
        // async & still pending - just update props and slots
        // since the component's reactive effect for render isn't set-up yet
        if (__DEV__) {
          pushWarningContext(n2)
        }
        updateComponentPreRender(instance, n2, optimized)
        if (__DEV__) {
          popWarningContext()
        }
        return
      } else {
        // 正常更新
        // normal update
        // 赋值 instance.next = n2，即最新的 vnode
        instance.next = n2
        // in case the child component is also queued, remove it to avoid
        // double updating the same child component in the same flush.
        // 如果子组件已经在队列中了，则移除，避免执行两次同样的更新
        invalidateJob(instance.update)
        // instance.update is the reactive effect.
        // 执行组件实例上挂载的 update 方法进行更新，即响应式副作用
        instance.update()
      }
    } else {
      // 如果组件不需要更新，则只简单的拷贝一些属性即可
      // no update needed. just copy over properties
      n2.component = n1.component
      n2.el = n1.el
      instance.vnode = n2
    }
  }

  /**
   * 设置渲染副作用
   * 1、创建响应式副作用，当组件依赖的响应式数据发生改变后，组件更新函数会按照制定的方式执行
   * 2、首次挂载，会自动执行一下更新函数，完成挂载
   * 3、定义组件更新函数
   *    3.1、如果组件未挂载，则执行挂载操作
   *      3.1.1、执行 beforeMount 钩子
   *      3.1.2、执行组件的渲染函数，生成 vnode
   *      3.1.3、调用 patch，将 vnode 渲染为 DOM
   *      3.1.4、执行 mounted 生命周期钩子
   *    3.2、如果已经挂载过了，则执行更新操作
   * @param instance 组件实例
   * @param initialVNode vnode
   * @param container 容器元素
   * @param anchor 参考元素
   * @param parentSuspense 
   * @param isSVG 
   * @param optimized 
   */
  const setupRenderEffect: SetupRenderEffectFn = (
    instance,
    initialVNode,
    container,
    anchor,
    parentSuspense,
    isSVG,
    optimized
  ) => {
    // 负责挂载、更新组件（在响应式数据发生改变后，该方法会被调用）
    const componentUpdateFn = () => {
      if (!instance.isMounted) {
        // 组件未挂载，执行挂载操作
        let vnodeHook: VNodeHook | null | undefined
        const { el, props } = initialVNode
        const { bm, m, parent } = instance
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode)

        toggleRecurse(instance, false)
        // 执行 beforeMount 钩子
        // beforeMount hook
        if (bm) {
          invokeArrayFns(bm)
        }
        // onVnodeBeforeMount
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeBeforeMount)
        ) {
          invokeVNodeHook(vnodeHook, parent, initialVNode)
        }
        // 兼容 Vue2 的 Hook Event
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeMount')
        }
        toggleRecurse(instance, true)

        // 同构渲染
        if (el && hydrateNode) {
          // vnode has adopted host node - perform hydration instead of mount.
          const hydrateSubTree = () => {
            if (__DEV__) {
              startMeasure(instance, `render`)
            }
            instance.subTree = renderComponentRoot(instance)
            if (__DEV__) {
              endMeasure(instance, `render`)
            }
            if (__DEV__) {
              startMeasure(instance, `hydrate`)
            }
            hydrateNode!(
              el as Node,
              instance.subTree,
              instance,
              parentSuspense,
              null
            )
            if (__DEV__) {
              endMeasure(instance, `hydrate`)
            }
          }

          if (isAsyncWrapperVNode) {
            ;(initialVNode.type as ComponentOptions).__asyncLoader!().then(
              // note: we are moving the render call into an async callback,
              // which means it won't track dependencies - but it's ok because
              // a server-rendered async wrapper is already in resolved state
              // and it will never need to change.
              () => !instance.isUnmounted && hydrateSubTree()
            )
          } else {
            hydrateSubTree()
          }
        } else {
          if (__DEV__) {
            startMeasure(instance, `render`)
          }
          // 执行组件渲染函数，得到组件 vnode
          const subTree = (instance.subTree = renderComponentRoot(instance))
          if (__DEV__) {
            endMeasure(instance, `render`)
          }
          if (__DEV__) {
            startMeasure(instance, `patch`)
          }
          // 调用 patch 函数，渲染 vnode 为真实元素(第一个参数（old vnode）为 null)
          patch(
            null,
            subTree,
            container,
            anchor,
            instance,
            parentSuspense,
            isSVG
          )
          if (__DEV__) {
            endMeasure(instance, `patch`)
          }
          // 在 vnode 上设置 el 选项，记录 DOM 元素和 vnode 的对应关系
          initialVNode.el = subTree.el
        }
        // 将组件的 mount 生命周期钩子放到队列中等待执行
        // mounted hook
        if (m) {
          queuePostRenderEffect(m, parentSuspense)
        }
        // onVnodeMounted
        if (
          !isAsyncWrapperVNode &&
          (vnodeHook = props && props.onVnodeMounted)
        ) {
          const scopedInitialVNode = initialVNode
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, scopedInitialVNode),
            parentSuspense
          )
        }
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:mounted'),
            parentSuspense
          )
        }

        // 组件被 keep-alive 包裹，首次渲染需要访问一下激活钩子
        // activated hook for keep-alive roots.
        // #1742 activated hook must be accessed after first render
        // since the hook may be injected by a child keep-alive
        if (initialVNode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense)
          if (
            __COMPAT__ &&
            isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
          ) {
            queuePostRenderEffect(
              () => instance.emit('hook:activated'),
              parentSuspense
            )
          }
        }
        // 更新实例的状态，标识组件已经挂载
        instance.isMounted = true

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentAdded(instance)
        }

        // #2458: deference mount-only object parameters to prevent memleaks
        initialVNode = container = anchor = null as any
      } else {
        // 组件已挂载，执行更新操作 
        // 组件自身状态改变和父组件重新渲染时调用 processComponent 都会触发更新
        // updateComponent
        // This is triggered by mutation of component's own state (next: null)
        // OR parent calling processComponent (next: VNode)
        let { next, bu, u, parent, vnode } = instance
        let originNext = next
        let vnodeHook: VNodeHook | null | undefined
        if (__DEV__) {
          pushWarningContext(next || instance.vnode)
        }

        // Disallow component effect recursion during pre-lifecycle hooks.
        toggleRecurse(instance, false)
        if (next) {
          next.el = vnode.el
          updateComponentPreRender(instance, next, optimized)
        } else {
          next = vnode
        }

        // beforeUpdate hook
        // 执行 beforeUpdate 钩子
        if (bu) {
          invokeArrayFns(bu)
        }
        // onVnodeBeforeUpdate
        if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
          invokeVNodeHook(vnodeHook, parent, next, vnode)
        }
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          instance.emit('hook:beforeUpdate')
        }
        toggleRecurse(instance, true)

        // render
        if (__DEV__) {
          startMeasure(instance, `render`)
        }
        // 执行渲染函数，得到新的 vnode
        const nextTree = renderComponentRoot(instance)
        if (__DEV__) {
          endMeasure(instance, `render`)
        }
        // 旧的 vnode
        const prevTree = instance.subTree
        // 更新组件实例的 vnode
        instance.subTree = nextTree

        if (__DEV__) {
          startMeasure(instance, `patch`)
        }
        // 更新
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          hostParentNode(prevTree.el!)!,
          // anchor may have changed if it's in a fragment
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          isSVG
        )
        if (__DEV__) {
          endMeasure(instance, `patch`)
        }
        next.el = nextTree.el
        if (originNext === null) {
          // self-triggered update. In case of HOC, update parent component
          // vnode el. HOC is indicated by parent instance's subTree pointing
          // to child component's vnode
          updateHOCHostEl(instance, nextTree.el)
        }
        // updated hook
        if (u) {
          queuePostRenderEffect(u, parentSuspense)
        }
        // onVnodeUpdated
        if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook!, parent, next!, vnode),
            parentSuspense
          )
        }
        if (
          __COMPAT__ &&
          isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
        ) {
          queuePostRenderEffect(
            () => instance.emit('hook:updated'),
            parentSuspense
          )
        }

        if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
          devtoolsComponentUpdated(instance)
        }

        if (__DEV__) {
          popWarningContext()
        }
      }
    }

    // create reactive effect for rendering
    // 创建响应式副作用，
    // 当组件依赖的响应式数据发生改变后，组件更新函数会按照指定的方式（第二个参数）执行
    const effect = (instance.effect = new ReactiveEffect(
      componentUpdateFn,
      // instance.update 其实就是 effect.run 方法，会在下面被赋值
      // 当响应式状态改变后，通过 trigger 触发 effect.scheduler 方法就是 () => queueJob(instance.update)
      () => queueJob(instance.update),
      instance.scope // track it in component's effect scope
    ))

    // 将 effect.run 赋值给 instance.update，待将来更新时执行
    const update = (instance.update = effect.run.bind(effect) as SchedulerJob)
    update.id = instance.uid
    // allowRecurse
    // #1801, #2043 component render effects should allow recursive updates
    toggleRecurse(instance, true)

    if (__DEV__) {
      effect.onTrack = instance.rtc
        ? e => invokeArrayFns(instance.rtc!, e)
        : void 0
      effect.onTrigger = instance.rtg
        ? e => invokeArrayFns(instance.rtg!, e)
        : void 0
      // @ts-ignore (for scheduler)
      update.ownerInstance = instance
    }

    // 首次挂载，直接执行 effect.run 方法进行页面渲染
    update()
  }

  const updateComponentPreRender = (
    instance: ComponentInternalInstance,
    nextVNode: VNode,
    optimized: boolean
  ) => {
    nextVNode.component = instance
    const prevProps = instance.vnode.props
    instance.vnode = nextVNode
    instance.next = null
    updateProps(instance, nextVNode.props, prevProps, optimized)
    updateSlots(instance, nextVNode.children, optimized)

    pauseTracking()
    // props update may have triggered pre-flush watchers.
    // flush them before the render update.
    flushPreFlushCbs(undefined, instance.update)
    resetTracking()
  }

  /**
   * 通过全量 diff 更新子节点
   * @param n1 oldVNode[]
   * @param n2 newVNode[]
   * @param container 容器节点
   * @param anchor 
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   * @returns 
   */
  const patchChildren: PatchChildrenFn = (
    n1,
    n2,
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    slotScopeIds,
    optimized = false
  ) => {
    // 旧的 vnode 的子节点
    const c1 = n1 && n1.children
    const prevShapeFlag = n1 ? n1.shapeFlag : 0
    // 新的 vnode 的子节点
    const c2 = n2.children

    const { patchFlag, shapeFlag } = n2
    // fast path
    // patchFlag 的存在意味着子节点都是数组，直接走全量更新即可
    if (patchFlag > 0) {
      if (patchFlag & PatchFlags.KEYED_FRAGMENT) {
        // 表示这些子节点有 key 或 部分有 key
        // this could be either fully-keyed or mixed (some keyed some not)
        // presence of patchFlag means children are guaranteed to be arrays
        patchKeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        return
      } else if (patchFlag & PatchFlags.UNKEYED_FRAGMENT) {
        // 表示这些子节点全部没有 key
        // 两组没有 key 的 vnode 进行全量 diff
        // unkeyed
        patchUnkeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        return
      }
    }

    // 走到这里，说明 newVNode 没有 patchFlag，那么子节点有三种可能：分别是文本、数组、空(没有子节点)
    // children has 3 possibilities: text, array or no children.
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // text children fast path
      // 新的子节点是文本节点
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // 如果旧的子节点是数组，则依次卸载每个节点
        unmountChildren(c1 as VNode[], parentComponent, parentSuspense)
      }
      // 如果新旧子节点不相等，则通过 DOM 操作直接更新
      if (c2 !== c1) {
        hostSetElementText(container, c2 as string)
      }
    } else {
      // 新的子节点是 数组 或 空
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // 旧的子节点是数组
        // prev children was array
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // 新的子节点也是数组，那么两个数据进行全量 diff
          // two arrays, cannot assume anything, do full diff
          patchKeyedChildren(
            c1 as VNode[],
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else {
          // 新的子节点是空，卸载旧的子节点
          // no new children, just unmount old
          unmountChildren(c1 as VNode[], parentComponent, parentSuspense, true)
        }
      } else {
        // 旧的子节点是文本或空
        // prev children was text OR null
        // new children is array OR null
        // 如果旧的子节点是文本节点，则先清空
        if (prevShapeFlag & ShapeFlags.TEXT_CHILDREN) {
          hostSetElementText(container, '')
        }
        // 如果新的子节点是数组，则执行 mountChildren 挂载这些子节点
        // mount new if array
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        }
      }
    }
  }

  /**
   * 两组没有 key 的 vnode 进行全量 diff，
   * diff 之后 oldVNode[] 有剩余则调用 unmountChildren 卸载剩余 vnode，
   * 如果 newVNode[] 有剩余，调用 mountChildren 挂载剩余 vnode
   * @param c1 oldVNode[]
   * @param c2 newVNode[]
   * @param container 容器节点
   * @param anchor 
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const patchUnkeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // 保证 c1、c2 为数组
    c1 = c1 || EMPTY_ARR
    c2 = c2 || EMPTY_ARR
    // c1 和 c2 的数组长度
    const oldLength = c1.length
    const newLength = c2.length
    // 较小的一个数组长度
    const commonLength = Math.min(oldLength, newLength)
    let i
    // 遍历数组，由于数组中的 vnode 都没有 key，没办法确认 oldVNode 和 newVNode 是否为同一节点，直接调用 patch 进行更新
    for (i = 0; i < commonLength; i++) {
      const nextChild = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized
      )
    }
    // 遍历结束后，如果 oldLenth > newLenth，说明有节点被删掉了，
    // 调用 unmountChildren 卸载 oldVNode[] 中剩余的元素，即下标从 commentLength 开始的元素，
    // 否则认为有新增的元素，则调用 mountChildren 挂载 newVNode[] 中剩余的元素
    if (oldLength > newLength) {
      // remove old
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true,
        false,
        commonLength
      )
    } else {
      // mount new
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized,
        commonLength
      )
    }
  }

  /**
   * can be all-keyed or mixed
   * 全量 diff 分为 5 步
   * 1. 从两组节点的开始位置向后遍历，如果两个节点相同，调用 patch 更新，如果不同，跳出循环
   * 2. 从两组节点的结束位置向前遍历，如果两个节点相同，调用 patch 更新，如果不同，跳出循环
   * 3. 经过上面两次循环之后，如果 newVnode[] 没遍历完，oldVNode[] 遍历完了，说明有新增元素，遍历剩下的元素，调用 patch 进行挂载
   * 4. 经过上面两次循环之后，如果 newVnode[] 遍历完了，oldVNode[] 没遍历完，说明有删除元素，遍历剩下的元素，调用 unmount 进行挂载
   * 5. 如果经过前两个循环遍历之后，newVNode[] 和 oldVNode[] 都没遍历完，接下来处理两个 vnode[] 中剩余的 vnode，下面说的 vnode[] 都是指两个数组中剩余的 vnode
   *  5.1 遍历 newVNode[]，以 vnode.key 为 key，vnode 所在的索引为 value，构建一个 Map
   *  5.2 遍历 oldVNode[]，从 Map 对象中寻找 oldVNode 对应的 newVNode，然后进行 patch，如果没找到则调用 unmount 卸载
   *    5.2.1 经过遍历，如果 newVNode[] 都处理完了，但是 oldVNode[] 还有剩余，则将剩下的 oldVNode 都卸载掉，如果相反，
   *          newVNode[] 有剩余，oldVNode[] 处理完了，则调用 patch 挂载剩余的 newVNode
   *  5.3 经过上面的步骤 5.2 处理之后，如果发现有需要移动的节点，则基于 VNode[] 中剩余的元素构造一个最长递增子序列，然后对相关元素进行移动或挂载
   * @param c1 oldVNode[]
   * @param c2 newVNode[]
   * @param container 容器节点
   * @param parentAnchor 
   * @param parentComponent 
   * @param parentSuspense 
   * @param isSVG 
   * @param slotScopeIds 
   * @param optimized 
   */
  const patchKeyedChildren = (
    c1: VNode[],
    c2: VNodeArrayChildren,
    container: RendererElement,
    parentAnchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    let i = 0
    // 新节点的数量
    const l2 = c2.length
    // 老节点数组的最后一个元素的索引
    let e1 = c1.length - 1 // prev ending index
    // 新节点数组的最后一个元素的索引
    let e2 = l2 - 1 // next ending index

    // 1. sync from start
    // (a b) c
    // (a b) d e
    // 从两组节点的开始位置向后遍历，如果两个节点相同，调用 patch 更新，如果不同，跳出循环
    while (i <= e1 && i <= e2) {
      // oldVNode
      const n1 = c1[i]
      // newVNode
      const n2 = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      if (isSameVNodeType(n1, n2)) {
        // 新旧 VNode 是同一个节点，则调用 patch 更新两个节点
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
      } else {
        // 新旧节点不是同一个节点，跳出循环
        break
      }
      i++
    }

    // 2. sync from end
    // a (b c)
    // d e (b c)
    // 从两组节点的结束位置向前遍历，如果两个节点相同，调用 patch 更新，如果不同，跳出循环
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1]
      const n2 = (c2[e2] = optimized
        ? cloneIfMounted(c2[e2] as VNode)
        : normalizeVNode(c2[e2]))
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVG,
          slotScopeIds,
          optimized
        )
      } else {
        break
      }
      e1--
      e2--
    }

    // 3. common sequence + mount
    // (a b)
    // (a b) c
    // i = 2, e1 = 1, e2 = 2
    // (a b)
    // c (a b)
    // i = 0, e1 = -1, e2 = 0
    // 经过上面两次循环之后，i > e1 && i <= e2，说明 oldVNode[] 已经遍历完了，但是 newVNode[] 还没遍历完，说明有新增元素，
    // while 遍历剩下的元素，调用 patch 进行挂载
    if (i > e1) {
      if (i <= e2) {
        const nextPos = e2 + 1
        const anchor = nextPos < l2 ? (c2[nextPos] as VNode).el : parentAnchor
        while (i <= e2) {
          patch(
            null,
            (c2[i] = optimized
              ? cloneIfMounted(c2[i] as VNode)
              : normalizeVNode(c2[i])),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
          i++
        }
      }
    }

    // 4. common sequence + unmount
    // (a b) c
    // (a b)
    // i = 2, e1 = 2, e2 = 1
    // a (b c)
    // (b c)
    // i = 0, e1 = 0, e2 = -1
    // 和上面的 if 分支相反，newVNode[] 已经遍历完了，但是 oldVNode[] 有剩余，说明剩下的元素需要被删掉，
    // while 遍历剩下的元素，调用 unmount 进行卸载
    else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true)
        i++
      }
    }

    // 5. unknown sequence
    // [i ... e1 + 1]: a b [c d e] f g
    // [i ... e2 + 1]: a b [e d c h] f g
    // i = 2, e1 = 4, e2 = 5
    // 走到这里，说明经过开始的两次循环，oldVNode[] 和 newVNode[] 都没遍历完（都有剩余），接下来就处理这些剩余的元素
    else {
      // 新旧 VNode 数组剩余元素的起始索引
      const s1 = i // prev starting index
      const s2 = i // next starting index

      // 5.1 build key:index map for newChildren
      // 遍历 newVNode[] 剩余的元素，以 vnode.key 为 key，vnode 在 newVNode[] 中的索引为 value 构建 Map 对象
      const keyToNewIndexMap: Map<string | number | symbol, number> = new Map()
      for (i = s2; i <= e2; i++) {
        const nextChild = (c2[i] = optimized
          ? cloneIfMounted(c2[i] as VNode)
          : normalizeVNode(c2[i]))
        if (nextChild.key != null) {
          if (__DEV__ && keyToNewIndexMap.has(nextChild.key)) {
            warn(
              `Duplicate keys found during update:`,
              JSON.stringify(nextChild.key),
              `Make sure keys are unique.`
            )
          }
          keyToNewIndexMap.set(nextChild.key, i)
        }
      }

      // 5.2 loop through old children left to be patched and try to patch
      // matching nodes & remove nodes that are no longer present
      let j
      // 已经被 patch 的元素数量
      let patched = 0
      // newVNode[] 中剩余需要被 patch 的元素数量
      const toBePatched = e2 - s2 + 1
      let moved = false
      // used to track whether any node has moved
      // 用于表示是否有元素需要被移动
      let maxNewIndexSoFar = 0
      // works as Map<newIndex, oldIndex>
      // Note that oldIndex is offset by +1
      // and oldIndex = 0 is a special value indicating the new node has
      // no corresponding old node.
      // used for determining longest stable subsequence
      // 构造一个 toBePatched 长度的数组，并将每个元素初始化为 0，用于构造最长递增子序列。
      // 数组中每个元素代码的意思是：第 x 个 newVNode 对应的 oldVNode 在 oldVNode[] 中的位置（索引 + 1），
      // 如果最终发现数组的某个元素为 0，则说明对应的 newVNode 没有对应的 oldVNode
      const newIndexToOldIndexMap = new Array(toBePatched)
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0

      // 遍历 oldVNode[] 中剩余未处理的 vnode。
      // 在 newVNode[] 中找到 oldVNode 对应的 vnode 的索引（newIndex），如果找不到调用 unmount 卸载 oldVNode，
      // 如果能找到，调用 patch 进行更新。
      // 在寻找的过程中，如果找的 newIndex 没有依次递增，即在某次循环中本该在后面位置找到的 vnode，
      // 现在却出现在了前面，则说明有元素需要被移动，设置 moved = true
      for (i = s1; i <= e1; i++) {
        // oldVNode
        const prevChild = c1[i]
        // 如果 patched >= toBePatched，说明 newVNode[] 中剩余 vnode 已经全部被 patch，
        // 但是 oldVNode[] 中仍旧有剩余 vnode，那说明这些 vnode 对应的节点被删掉了，则调用 unmount 卸载这些 vnode
        if (patched >= toBePatched) {
          // all new children have been patched so this can only be a removal
          unmount(prevChild, parentComponent, parentSuspense, true)
          continue
        }
        // 找到 oldVNode 对应的 newVNode 在 newVNode[] 中的索引
        let newIndex
        if (prevChild.key != null) {
          // 通过 oldVNode.key 在 Map 中找到对应的 newVNode 在 newVNode[] 中的索引
          newIndex = keyToNewIndexMap.get(prevChild.key)
        } else {
          // 如果说 oldVNode.key 不存在，则遍历 newVNode[]，找到对应节点 oldVNode 在 newVNode[] 中对应节点的索引
          // 这里需要注意一点，vnode.key 不存在，则为 undefined，undefined === undefined => true
          // key-less node, try to locate a key-less node of the same type
          for (j = s2; j <= e2; j++) {
            if (
              newIndexToOldIndexMap[j - s2] === 0 &&
              isSameVNodeType(prevChild, c2[j] as VNode)
            ) {
              newIndex = j
              break
            }
          }
        }
        if (newIndex === undefined) {
          // 索引不存在，说明 oldVNode 在 newVNode[] 中没找到对应的 vnode，调用 unmount 卸载 oldVNode
          unmount(prevChild, parentComponent, parentSuspense, true)
        } else {
          // 索引存在，说明 oldVNode 在 newVNode[] 中找到了对应的 vnode

          // 存储第 x 个 newVNode 对应的 oldVNode 的在 oldVNode[] 中对应的位置（索引 + 1）
          // x 是以 newVNode[] 中剩余 vnode 来计算的，比如 newIndex - s2 = 2，表示剩余中的第 3 个 vnode
          newIndexToOldIndexMap[newIndex - s2] = i + 1
          // 如果找的 newVNode 对应的索引 < maxNewIndexSoFar，说明节点需要被移动，否则 maxNewIndexSoFar = newIndex。
          // maxNewIndexSoFar 默认为 0，如果每个元素都不需要被移动，则说明 newIndex 永远 >= maxNewIndexSoFar，
          // 因为 oldVNode[] 是从前往后遍历，在不需要移动元素的情况下，找到的对应的 newIndex 也应该是依次递增的，
          // 所以一旦出现了 newIndex < maxNewIndexSoFar，就说明有元素需要被移动，因为本应该出现在后面的元素，
          // 现在却在前面找到了
          if (newIndex >= maxNewIndexSoFar) {
            maxNewIndexSoFar = newIndex
          } else {
            moved = true
          }
          // patch vnode
          patch(
            prevChild,
            c2[newIndex] as VNode,
            container,
            null,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
          // 更新已 patch 的 vnode 的数量
          patched++
        }
      }

      // 5.3 move and mount
      // generate longest stable subsequence only when nodes have moved
      // 当存在需要被移动的节点时，构造最长递增子序列
      const increasingNewIndexSequence = moved
        ? getSequence(newIndexToOldIndexMap)
        : EMPTY_ARR
      j = increasingNewIndexSequence.length - 1
      // looping backwards so that we can use last patched node as anchor
      // 移动和挂载元素
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i
        const nextChild = c2[nextIndex] as VNode
        const anchor =
          nextIndex + 1 < l2 ? (c2[nextIndex + 1] as VNode).el : parentAnchor
        if (newIndexToOldIndexMap[i] === 0) {
          // mount new
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            slotScopeIds,
            optimized
          )
        } else if (moved) {
          // move if:
          // There is no stable subsequence (e.g. a reverse)
          // OR current node is not among the stable sequence
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            move(nextChild, container, anchor, MoveType.REORDER)
          } else {
            j--
          }
        }
      }
    }
  }

  const move: MoveFn = (
    vnode,
    container,
    anchor,
    moveType,
    parentSuspense = null
  ) => {
    const { el, type, transition, children, shapeFlag } = vnode
    if (shapeFlag & ShapeFlags.COMPONENT) {
      move(vnode.component!.subTree, container, anchor, moveType)
      return
    }

    if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
      vnode.suspense!.move(container, anchor, moveType)
      return
    }

    if (shapeFlag & ShapeFlags.TELEPORT) {
      ;(type as typeof TeleportImpl).move(vnode, container, anchor, internals)
      return
    }

    if (type === Fragment) {
      hostInsert(el!, container, anchor)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move((children as VNode[])[i], container, anchor, moveType)
      }
      hostInsert(vnode.anchor!, container, anchor)
      return
    }

    if (type === Static) {
      moveStaticNode(vnode, container, anchor)
      return
    }

    // single nodes
    const needTransition =
      moveType !== MoveType.REORDER &&
      shapeFlag & ShapeFlags.ELEMENT &&
      transition
    if (needTransition) {
      if (moveType === MoveType.ENTER) {
        transition!.beforeEnter(el!)
        hostInsert(el!, container, anchor)
        queuePostRenderEffect(() => transition!.enter(el!), parentSuspense)
      } else {
        const { leave, delayLeave, afterLeave } = transition!
        const remove = () => hostInsert(el!, container, anchor)
        const performLeave = () => {
          leave(el!, () => {
            remove()
            afterLeave && afterLeave()
          })
        }
        if (delayLeave) {
          delayLeave(el!, remove, performLeave)
        } else {
          performLeave()
        }
      }
    } else {
      hostInsert(el!, container, anchor)
    }
  }

  const unmount: UnmountFn = (
    vnode,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false
  ) => {
    const {
      type,
      props,
      ref,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      dirs
    } = vnode
    // unset ref
    if (ref != null) {
      setRef(ref, null, parentSuspense, vnode, true)
    }

    if (shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE) {
      ;(parentComponent!.ctx as KeepAliveContext).deactivate(vnode)
      return
    }

    const shouldInvokeDirs = shapeFlag & ShapeFlags.ELEMENT && dirs
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode)

    let vnodeHook: VNodeHook | undefined | null
    if (
      shouldInvokeVnodeHook &&
      (vnodeHook = props && props.onVnodeBeforeUnmount)
    ) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode)
    }

    if (shapeFlag & ShapeFlags.COMPONENT) {
      unmountComponent(vnode.component!, parentSuspense, doRemove)
    } else {
      if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
        vnode.suspense!.unmount(parentSuspense, doRemove)
        return
      }

      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount')
      }

      if (shapeFlag & ShapeFlags.TELEPORT) {
        ;(vnode.type as typeof TeleportImpl).remove(
          vnode,
          parentComponent,
          parentSuspense,
          optimized,
          internals,
          doRemove
        )
      } else if (
        dynamicChildren &&
        // #1153: fast path should not be taken for non-stable (v-for) fragments
        (type !== Fragment ||
          (patchFlag > 0 && patchFlag & PatchFlags.STABLE_FRAGMENT))
      ) {
        // fast path for block nodes: only need to unmount dynamic children.
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true
        )
      } else if (
        (type === Fragment &&
          patchFlag &
            (PatchFlags.KEYED_FRAGMENT | PatchFlags.UNKEYED_FRAGMENT)) ||
        (!optimized && shapeFlag & ShapeFlags.ARRAY_CHILDREN)
      ) {
        unmountChildren(children as VNode[], parentComponent, parentSuspense)
      }

      if (doRemove) {
        remove(vnode)
      }
    }

    if (
      (shouldInvokeVnodeHook &&
        (vnodeHook = props && props.onVnodeUnmounted)) ||
      shouldInvokeDirs
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        shouldInvokeDirs &&
          invokeDirectiveHook(vnode, null, parentComponent, 'unmounted')
      }, parentSuspense)
    }
  }

  const remove: RemoveFn = vnode => {
    const { type, el, anchor, transition } = vnode
    if (type === Fragment) {
      removeFragment(el!, anchor!)
      return
    }

    if (type === Static) {
      removeStaticNode(vnode)
      return
    }

    const performRemove = () => {
      hostRemove(el!)
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave()
      }
    }

    if (
      vnode.shapeFlag & ShapeFlags.ELEMENT &&
      transition &&
      !transition.persisted
    ) {
      const { leave, delayLeave } = transition
      const performLeave = () => leave(el!, performRemove)
      if (delayLeave) {
        delayLeave(vnode.el!, performRemove, performLeave)
      } else {
        performLeave()
      }
    } else {
      performRemove()
    }
  }

  const removeFragment = (cur: RendererNode, end: RendererNode) => {
    // For fragments, directly remove all contained DOM nodes.
    // (fragment child nodes cannot have transition)
    let next
    while (cur !== end) {
      next = hostNextSibling(cur)!
      hostRemove(cur)
      cur = next
    }
    hostRemove(end)
  }

  const unmountComponent = (
    instance: ComponentInternalInstance,
    parentSuspense: SuspenseBoundary | null,
    doRemove?: boolean
  ) => {
    if (__DEV__ && instance.type.__hmrId) {
      unregisterHMR(instance)
    }

    const { bum, scope, update, subTree, um } = instance

    // beforeUnmount hook
    if (bum) {
      invokeArrayFns(bum)
    }

    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      instance.emit('hook:beforeDestroy')
    }

    // stop effects in component scope
    scope.stop()

    // update may be null if a component is unmounted before its async
    // setup has resolved.
    if (update) {
      // so that scheduler will no longer invoke it
      update.active = false
      unmount(subTree, instance, parentSuspense, doRemove)
    }
    // unmounted hook
    if (um) {
      queuePostRenderEffect(um, parentSuspense)
    }
    if (
      __COMPAT__ &&
      isCompatEnabled(DeprecationTypes.INSTANCE_EVENT_HOOKS, instance)
    ) {
      queuePostRenderEffect(
        () => instance.emit('hook:destroyed'),
        parentSuspense
      )
    }
    queuePostRenderEffect(() => {
      instance.isUnmounted = true
    }, parentSuspense)

    // A component with async dep inside a pending suspense is unmounted before
    // its async dep resolves. This should remove the dep from the suspense, and
    // cause the suspense to resolve immediately if that was the last dep.
    if (
      __FEATURE_SUSPENSE__ &&
      parentSuspense &&
      parentSuspense.pendingBranch &&
      !parentSuspense.isUnmounted &&
      instance.asyncDep &&
      !instance.asyncResolved &&
      instance.suspenseId === parentSuspense.pendingId
    ) {
      parentSuspense.deps--
      if (parentSuspense.deps === 0) {
        parentSuspense.resolve()
      }
    }

    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      devtoolsComponentRemoved(instance)
    }
  }

  const unmountChildren: UnmountChildrenFn = (
    children,
    parentComponent,
    parentSuspense,
    doRemove = false,
    optimized = false,
    start = 0
  ) => {
    for (let i = start; i < children.length; i++) {
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized)
    }
  }

  const getNextHostNode: NextFn = vnode => {
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      return getNextHostNode(vnode.component!.subTree)
    }
    if (__FEATURE_SUSPENSE__ && vnode.shapeFlag & ShapeFlags.SUSPENSE) {
      return vnode.suspense!.next()
    }
    return hostNextSibling((vnode.anchor || vnode.el)!)
  }

  /**
   * 1、将 vnode 渲染（挂载、更新、卸载）为 DOM 元素
   * 2、另外还执行了那些需要在页面渲染完成后执行的副作用函数
   * 3、在渲染结束后将 vnode 对象设置到 container._vnode 上，记录 vnode 和 DOM 对应关系
   */
  const render: RootRenderFunction = (vnode, container, isSVG) => {
    if (vnode == null) {
      // 如果 vnode 为空，并且 container._vnode 存在，则说明是要卸载组件
      if (container._vnode) {
        unmount(container._vnode, null, null, true)
      }
    } else {
      // 挂载、更新
      patch(container._vnode || null, vnode, container, null, null, null, isSVG)
    }
    // 执行那些需要在页面渲染完成后执行的副作用函数，比如用户 watcher 的 配置项为 { flush: 'post' }，
    // 默认为 { flush: 'pre' }，也就是说用户设置的副作用函数默认都是在组件的更新函数前执行
    flushPostFlushCbs()
    // 将 vnode 设置到选择器的 _vnode 选项上，下次再进来（更新时）会用到
    container._vnode = vnode
  }

  const internals: RendererInternals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options
  }

  let hydrate: ReturnType<typeof createHydrationFunctions>[0] | undefined
  let hydrateNode: ReturnType<typeof createHydrationFunctions>[1] | undefined
  if (createHydrationFns) {
    ;[hydrate, hydrateNode] = createHydrationFns(
      internals as RendererInternals<Node, Element>
    )
  }

  return {
    render,
    hydrate,
    // createApp 方法是 createAppAPI 方法的返回值
    createApp: createAppAPI(render, hydrate)
  }
}

function toggleRecurse(
  { effect, update }: ComponentInternalInstance,
  allowed: boolean
) {
  effect.allowRecurse = update.allowRecurse = allowed
}

/**
 * 针对开发环境的热更新和含有 v-for 指令的 template fragment。
 * 将所有子节点的 oldVNode.el 同步到 newVNode.el 上，以确保子节点可以被正常更新
 * 
 * #1156
 * When a component is HMR-enabled, we need to make sure that all static nodes
 * inside a block also inherit the DOM element from the previous tree so that
 * HMR updates (which are full updates) can retrieve the element for patching.
 *
 * #2080
 * Inside keyed `template` fragment static children, if a fragment is moved,
 * the children will always be moved. Therefore, in order to ensure correct move
 * position, el should be inherited from previous nodes.
 */
export function traverseStaticChildren(n1: VNode, n2: VNode, shallow = false) {
  const ch1 = n1.children
  const ch2 = n2.children
  if (isArray(ch1) && isArray(ch2)) {
    for (let i = 0; i < ch1.length; i++) {
      // this is only called in the optimized path so array children are
      // guaranteed to be vnodes
      const c1 = ch1[i] as VNode
      let c2 = ch2[i] as VNode
      if (c2.shapeFlag & ShapeFlags.ELEMENT && !c2.dynamicChildren) {
        if (c2.patchFlag <= 0 || c2.patchFlag === PatchFlags.HYDRATE_EVENTS) {
          c2 = ch2[i] = cloneIfMounted(ch2[i] as VNode)
          c2.el = c1.el
        }
        if (!shallow) traverseStaticChildren(c1, c2)
      }
      // also inherit for comment nodes, but not placeholders (e.g. v-if which
      // would have received .el during block patch)
      if (__DEV__ && c2.type === Comment && !c2.el) {
        c2.el = c1.el
      }
    }
  }
}

/**
 * https://en.wikipedia.org/wiki/Longest_increasing_subsequence
 *
 * 构造最长递增子序列 

 * @param [number[]] arr 
 * @returns 
 */
function getSequence(arr: number[]): number[] {
  // 数组备份
  const p = arr.slice()
  const result = [0]
  let i, j, u, v, c
  const len = arr.length
  for (i = 0; i < len; i++) {
    const arrI = arr[i]
    if (arrI !== 0) {
      // result 中最后一个元素的值
      j = result[result.length - 1]
      // 如果 result 中最后一个元素 < arr[i]，将 i push 进 result 数组
      if (arr[j] < arrI) {
        p[i] = j
        result.push(i)
        continue
      }
      // 下面是二分查找的过程
      // result 数组的开始索引，即 left
      u = 0
      // result 数组的结束索引，即 right
      v = result.length - 1
      while (u < v) {
        // 找到开始索引和结束索引的中间值，mid
        c = (u + v) >> 1
        // 如果 arr[result[mid]] < arr[i]，说明要找的位置在右边，更新 left(u) 为 mid(c) + 1，否则 right(v) 为 mid(c)
        if (arr[result[c]] < arrI) {
          u = c + 1
        } else {
          v = c
        }
      }
      if (arrI < arr[result[u]]) {
        if (u > 0) {
          p[i] = result[u - 1]
        }
        result[u] = i
      }
    }
  }
  u = result.length
  v = result[u - 1]
  while (u-- > 0) {
    result[u] = v
    v = p[v]
  }
  return result
}
