// This entry is the "full-build" that includes both the runtime
// and the compiler, and supports on-the-fly compilation of the template option.
import { initDev } from './dev'
import { compile, CompilerOptions, CompilerError } from '@vue/compiler-dom'
import { registerRuntimeCompiler, RenderFunction, warn } from '@vue/runtime-dom'
import * as runtimeDom from '@vue/runtime-dom'
import { isString, NOOP, generateCodeFrame, extend } from '@vue/shared'
import { InternalRenderFunction } from 'packages/runtime-core/src/component'

if (__DEV__) {
  initDev()
}

const compileCache: Record<string, RenderFunction> = Object.create(null)

/**
 * 将模板编译为渲染函数
 * 1. 异常处理，得到正确的的 template
 * 2. 调用 compiler-dom 包 的 compile 方法将字符串模板编译为生成渲染函数的代码字符串
 * 3. 将代码字符串变为函数并执行，得到模板的渲染函数
 * 4. 缓存渲染函数，以模板为 key，渲染函数为 value
 * @param template 模板（字符串 或 DOM 节点）
 * @param options 编译器选项
 * @returns 
 */
function compileToFunction(
  template: string | HTMLElement,
  options?: CompilerOptions
): RenderFunction {
  // template 不是字符串，则获取 template.innerHTML 为模板内容，如果既不是字符串也不是 DOM 节点，则说明不是有效的模板，抛出错误
  if (!isString(template)) {
    if (template.nodeType) {
      template = template.innerHTML
    } else {
      __DEV__ && warn(`invalid template option: `, template)
      return NOOP
    }
  }

  // 缓存，以模板为 key，模板的渲染函数为 value，避免模板被重复渲染
  const key = template
  const cached = compileCache[key]
  if (cached) {
    return cached
  }

  // 如果 template 以 # 开头，说明是个选择器，则获取对应元素的 innerHTML 作为 模板 内容
  if (template[0] === '#') {
    const el = document.querySelector(template)
    if (__DEV__ && !el) {
      warn(`Template element not found or is empty: ${template}`)
    }
    // __UNSAFE__
    // Reason: potential execution of JS expressions in in-DOM template.
    // The user must make sure the in-DOM template is trusted. If it's rendered
    // by the server, the template should not contain any user data.
    template = el ? el.innerHTML : ``
  }

  // 调用 compiler-dom 包的 compile 方法，将模板编译为生成渲染函数的代码字符串
  const { code } = compile(
    template,
    extend(
      {
        hoistStatic: true,
        onError: __DEV__ ? onError : undefined,
        onWarn: __DEV__ ? e => onError(e, true) : NOOP
      } as CompilerOptions,
      options
    )
  )

  // 编译器在开发环境下的错误处理
  function onError(err: CompilerError, asWarning = false) {
    const message = asWarning
      ? err.message
      : `Template compilation error: ${err.message}`
    const codeFrame =
      err.loc &&
      generateCodeFrame(
        template as string,
        err.loc.start.offset,
        err.loc.end.offset
      )
    warn(codeFrame ? `${message}\n${codeFrame}` : message)
  }

  // 将字符串代码生成函数，并执行，得到模板对应的渲染函数
  // The wildcard import results in a huge object with every export
  // with keys that cannot be mangled, and can be quite heavy size-wise.
  // In the global build we know `Vue` is available globally so we can avoid
  // the wildcard object.
  const render = (
    __GLOBAL__ ? new Function(code)() : new Function('Vue', code)(runtimeDom)
  ) as RenderFunction
  debugger

  // 标记渲染函数是由编译器生成的
  // mark the function as runtime compiled
  ;(render as InternalRenderFunction)._rc = true

  // 设置缓存，并返回渲染函数
  return (compileCache[key] = render)
}

// 为运行时注册编译器
registerRuntimeCompiler(compileToFunction)

export { compileToFunction as compile }
export * from '@vue/runtime-dom'
