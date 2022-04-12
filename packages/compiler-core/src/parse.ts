import { ErrorHandlingOptions, ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import {
  ErrorCodes,
  createCompilerError,
  defaultOnError,
  defaultOnWarn
} from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent,
  isStaticArgOf
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot,
  ConstantTypes
} from './ast'
import {
  checkCompatEnabled,
  CompilerCompatOptions,
  CompilerDeprecationTypes,
  isCompatEnabled,
  warnDeprecation
} from './compat/compatConfig'

type OptionalOptions =
  | 'whitespace'
  | 'isNativeTag'
  | 'isBuiltInComponent'
  | keyof CompilerCompatOptions
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> &
  Pick<ParserOptions, OptionalOptions>
type AttributeValue =
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError,
  onWarn: defaultOnWarn,
  comments: __DEV__
}

export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea>
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

export interface ParserContext {
  options: MergedParserOptions
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  inPre: boolean // HTML <pre> tag, preserve whitespaces
  inVPre: boolean // v-pre, do not process directives and interpolations
  onWarn: NonNullable<ErrorHandlingOptions['onWarn']>
}

/**
 * 解析模版字符串，得到模版的 ast 对象（模版 AST 是作为 ROOT 节点的子节点出现的）
 * @param content 字符串模版
 * @param options 编译选项
 * @returns 
 */
export function baseParse(
  content: string,
  options: ParserOptions = {}
): RootNode {
  // 创建解析上下文，上下文中包括行列好、合并后的编译选项、偏移量、模版信息等
  const context = createParserContext(content, options)
  // 获取当前游标信息（行列号、偏移量）
  const start = getCursor(context)
  // 创建根节点，模版的解析结果为作为根节点的子节点存在
  return createRoot(
    // 将模版字符串按照一定的规则，切割为一个个的 node（即编译原理中词法解析、语法解析之后得到的 token），最后返回模版对应的 AST 组成的节点数组
    parseChildren(context, TextModes.DATA, []),
    // 获取当前节点在字符串模版中的位置信息，比如开始位置、结束位置、模版内容
    getSelection(context, start)
  )
}

/**
 * 创建解析上下文，上下文中包括行列好、合并后的编译选项、偏移量、模版信息等
 * @param content 字符串模版
 * @param rawOptions 高阶编译器传递进来的编译选项
 * @returns
 */
function createParserContext(
  content: string,
  rawOptions: ParserOptions
): ParserContext {
  // 默认选项
  const options = extend({}, defaultParserOptions)

  // 选项合并，将默认选项和传递进来的编译器选项合并
  let key: keyof ParserOptions
  for (key in rawOptions) {
    // @ts-ignore
    options[key] =
      rawOptions[key] === undefined
        ? defaultParserOptions[key]
        : rawOptions[key]
  }
  // 返回解析上下文
  return {
    // 选项
    options,
    // 列号
    column: 1,
    // 行号
    line: 1,
    // 偏移量
    offset: 0,
    // 字符串模版原始值，字符串模版的备份
    originalSource: content,
    // 字符串模版，解析过程中处理该字段
    source: content,
    // 当前节点是否在 pre 标签内
    inPre: false,
    // 当前节点是否在 v-pre 指令所在的节点内部
    inVPre: false,
    // 警告，异常提示
    onWarn: options.onWarn
  }
}

/**
 * 将模版字符串按照一定的规则，切割为一个个的 node（即编译原理中词法解析、语法解析之后得到的 token），最后返回模版对应的 AST 组成的节点数组
 * @param context 解析上下文
 * @param mode 模式
 * @param ancestors 栈（数组），存放当前节点的所有祖代节点，比如 [祖宗节点们, 爷爷节点, 父节点]
 * @returns 
 */
function parseChildren(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  // 获取父节点
  const parent = last(ancestors)
  // 命名空间
  const ns = parent ? parent.ns : Namespaces.HTML
  // 模版解析后得到的所有节点
  const nodes: TemplateChildNode[] = []

  // 如果匹配到结束位置（比如闭合标签），就跳出 while 循环
  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    // 字符串模版
    const s = context.source
    // 本次循环解析得到的节点
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    // DATA 或 RCDATA 模式下，解析插值表达式、注释节点、合法的 CDATA 片段、开始标签、闭合标签，以及抛出除此以外的异常情况
    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) {
        // 模版以 '{{' 开头，说明匹配到的插值表达式，解析插值表达式
        // 从字符串模版的当前位置解析出插值表达式，并调整解析上下文，然后返回插值节点
        node = parseInterpolation(context, mode)
      } else if (mode === TextModes.DATA && s[0] === '<') {
        // DATA 模式，并且模版以 < 开头
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        if (s.length === 1) {
          // 模版就一个 <，属于异常情况
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
        } else if (s[1] === '!') {
          // 模版的开始位置匹配到了 <!
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          if (startsWith(s, '<!--')) {
            // 模版开始位置匹配到了 <!--，说明是注释节点，解析注释节点
            // 从字符串模版的当前位置解析出注释内容，并调整解析上下文，然后注释节点
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) {
            // 匹配到了 <!DOCTYPE，文档类型声明，忽略掉，当作注释节点处理
            // Ignore DOCTYPE by a limitation.
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) {
            // 匹配到了 <![CDATA[ 片段，比如 <![CDATA[ 这里可以包含未经转义的字符，比如 < > & 等 ]]>
            // 如果不是在 HTML 命令空间下匹配到 CDATA，则处理 CDATA 片段，
            // 否则抛出错误，CDATA 不应该出现在 HTML 中，值在 XML 中有效
            if (ns !== Namespaces.HTML) {
              // 递归调用 parseChildren，以 CDATA 模式解析 CDATA 片段的所有子节点，并返回节点列表
              node = parseCDATA(context, ancestors)
            } else {
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              // HTML 中出现 CDATA 片段，不合理，忽略，并当作注释节点处理
              node = parseBogusComment(context)
            }
          } else {
            // 如果上述情况都没命中，则 认为 <! 是非法字符，抛出错误
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }
        } else if (s[1] === '/') {
          // 匹配到了 /，那么目前匹配到的字符就是 </
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) {
            // 模版内容是 </，抛出错误
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
          } else if (s[2] === '>') {
            // 匹配到非法字符 </>，抛出错误，并将
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            // 从模版字符串的开头位置截掉 3 个字符，并更新上下文中的位置信息
            advanceBy(context, 3)
            continue
          } else if (/[a-z]/i.test(s[2])) {
            // 匹配到 </字母 a-z，比如 </d，说明匹配到了闭合标签，解析闭合标签
            emitError(context, ErrorCodes.X_INVALID_END_TAG)
            parseTag(context, TagType.End, parent)
            continue
          } else {
            // 上述情况都未命中，抛出错误，出现了异常标记
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }
        } else if (/[a-z]/i.test(s[1])) {
          // 匹配到 <字母 a-z，比如 <div，说明是开始标签，解析开始标签，得到模版对应的 AST 对象（当前节点以及对应的子节点）
          node = parseElement(context, ancestors)

          // 2.x <template> with no directive compat
          if (
            __COMPAT__ &&
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
              context
            ) &&
            node &&
            node.tag === 'template' &&
            !node.props.some(
              p =>
                p.type === NodeTypes.DIRECTIVE &&
                isSpecialTemplateDirective(p.name)
            )
          ) {
            __DEV__ &&
              warnDeprecation(
                CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
                context,
                node.loc
              )
            node = node.children
          }
        } else if (s[1] === '?') {
          // 匹配到 <?，异常标记，抛出错误
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )
          node = parseBogusComment(context)
        } else {
          // 走到这里，说明匹配到的是 <无效字符，抛出错误
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
        }
      }
    }
    // 如果走到这里，node 仍然为空，说明模版是一段纯文本。解析文本节点
    if (!node) {
      // 从字符串模版的当前位置开始解析出第一个结束标签之前的文本内容，然后返回文本节点
      node = parseText(context, mode)
    }

    // 将本次循环解析得到的节点添加到 nodes 数组中
    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i])
      }
    } else {
      pushNode(nodes, node)
    }
  }

  // Whitespace handling strategy like v2
  let removedWhitespace = false
  // 在非 RAWTEXT 和 RCDATA 模式下处理空白字符
  if (mode !== TextModes.RAWTEXT && mode !== TextModes.RCDATA) {
    const shouldCondense = context.options.whitespace !== 'preserve'
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      // 当前节点是非 pre 节点的子节点 && 节点是文本类型
      if (!context.inPre && node.type === NodeTypes.TEXT) {
        if (!/[^\t\r\n\f ]/.test(node.content)) {
          // 文本节点的 content 以空白字符开头
          const prev = nodes[i - 1]
          const next = nodes[i + 1]
          // Remove if:
          // - the whitespace is the first or last node, or:
          // - (condense mode) the whitespace is adjacent to a comment, or:
          // - (condense mode) the whitespace is between two elements AND contains newline
          // 如果：
          // - 空白是第一个或最后一个节点，或者：
          // - 压缩模式下空格与注释相邻，或者：
          // - 压缩模式下空格位于两个元素之间，包含换行符
          // 直接将节点置空，后面 return 时会清理掉 nodes 中的空节点，
          // 否则压缩 node.content
          if (
            !prev ||
            !next ||
            (shouldCondense &&
              (prev.type === NodeTypes.COMMENT ||
                next.type === NodeTypes.COMMENT ||
                (prev.type === NodeTypes.ELEMENT &&
                  next.type === NodeTypes.ELEMENT &&
                  /[\r\n]/.test(node.content))))
          ) {
            // 直接将整个节点都删掉了
            removedWhitespace = true
            nodes[i] = null as any
          } else {
            // 压缩 node.content
            // Otherwise, the whitespace is condensed into a single space
            node.content = ' '
          }
        } else if (shouldCondense) {
          // 在压缩模式下，文本节点中的连续空白字符被压缩为单个空格
          // in condense mode, consecutive whitespaces in text are condensed
          // down to a single space.
          node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
        }
      }
      // Remove comment nodes if desired by configuration.
      else if (node.type === NodeTypes.COMMENT && !context.options.comments) {
        // 如果配置项没说要保留注释，则直接删除注释节点
        removedWhitespace = true
        nodes[i] = null as any
      }
    }
    // 当前节点在 pre 节点内，根据 html 规范删除前导换行符
    if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  // 去除 nodes 中的空白节点，并返回 nodes
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

/**
 * 如果本次解析得到节点和上一个节点都是文本节点，并且是连续的，则当前节点合并到上一个节点中（拼接文本、调整位置信息），
 * 否则将当前 node push 到 nodes 数组中
 * @param nodes 模版解析得到的所有节点
 * @param node 节点
 * @returns 
 */
function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  // 如果本次解析得到节点和上一个节点都是文本节点，并且是连续的，则当前节点合并到上一个节点中（拼接文本、调整位置信息），
  // 否则将当前 node push 到 nodes 数组中
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }

  nodes.push(node)
}

/**
 * 递归调用 parseChildren，以 CDATA 模式解析 CDATA 片段的所有子节点，并返回节点列表
 * <![CDATA[ 这里可以包含未经转义的字符，比如 < > & 等 ]]>
 * @param context 
 * @param ancestors 
 * @returns 
 */
function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  // 切除片段的开始字符：<![CDATA
  advanceBy(context, 9)
  // 以 CDATA 模式解析片段的子节点
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  // 返回解析得到的所有子节点
  return nodes
}

/**
 * 从字符串模版的当前位置解析出注释内容，并调整解析上下文，然后注释节点
 * @param context 解析上下文
 * @returns 
 */
function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

/**
 * 解析一些需要忽略掉或不合理的内容，将这些内容当作注释节点来处理
 * @param context 
 * @returns 
 */
function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

/**
 * 解析元素，即得到模版对应的 AST 对象
 * @param context 解析上下文
 * @param ancestors 当前要解析的节点的所有祖代节点
 * @returns 
 */
function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // 开始标签
  // 当前节点是否在 pre 标签内，比如 <pre><div>解析 div 时，inPre 就为 true</div></pre>
  const wasInPre = context.inPre
  // 当前节点是否在 v-pre 指令所在的节点内，比如 <div v-pre><span>解析 span 标签时，inVPre 就为 true</span></div>
  const wasInVPre = context.inVPre
  // 父节点
  const parent = last(ancestors)
  // 解析开始标签 或 自闭合标签，比如 `<div id=a>` 或 <img />，得到对应的节点信息，比如标签名、属性节点、当前节点的位置信息 等
  const element = parseTag(context, TagType.Start, parent)
  // 判断当前节点是否属于边界节点，比如祖代节点中不存在 v-pre 指令，节点自己存在 v-pre 指令
  const isPreBoundary = context.inPre && !wasInPre
  const isVPreBoundary = context.inVPre && !wasInVPre

  // 如果是自闭合标签或者空标签，则直接返回解析得到的节点，因为这两种标签没有子节点
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    // #4030 self-closing <pre> tag
    if (isPreBoundary) {
      context.inPre = false
    }
    if (isVPreBoundary) {
      context.inVPre = false
    }
    return element
  }

  /** 处理当前节点的子节点 **/
  // Children.
  // 将当前节点 push 进 ancestors 数组，座位其后续解析子节点时的父节点
  ancestors.push(element)
  // 获取当前节点的解析模式
  const mode = context.options.getTextMode(element, parent)
  // 递归调用 parseChildren 解析当前节点的子节点
  const children = parseChildren(context, mode, ancestors)
  // 子节点解析完成后，从 ancestors 数组末尾弹出当前节点
  ancestors.pop()

  // 2.x inline-template compat
  if (__COMPAT__) {
    const inlineTemplateProp = element.props.find(
      p => p.type === NodeTypes.ATTRIBUTE && p.name === 'inline-template'
    ) as AttributeNode
    if (
      inlineTemplateProp &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE,
        context,
        inlineTemplateProp.loc
      )
    ) {
      const loc = getSelection(context, element.loc.end)
      inlineTemplateProp.value = {
        type: NodeTypes.TEXT,
        content: loc.source,
        loc
      }
    }
  }

  // 设置当前节点的子节点
  element.children = children

  // 开始标签和对应的子节点都解析完了，接下来解析当前节点的闭合标签
  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    parseTag(context, TagType.End, parent)
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  // 设置当前节点在模版字符串中的位置信息
  element.loc = getSelection(context, element.loc.start)

  // 当前节点解析完了后将上下文中的 inPre 和 inVPre 属性重置为 false，解析当前节点的兄弟节点或父节点时需要用到
  if (isPreBoundary) {
    context.inPre = false
  }
  if (isVPreBoundary) {
    context.inVPre = false
  }
  // 返回当前节点对应模版的 ast 对象（当前节点本身以及其子节点）
  return element
}

const enum TagType {
  Start,
  End
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(
  context: ParserContext,
  type: TagType.Start,
  parent: ElementNode | undefined
): ElementNode
function parseTag(
  context: ParserContext,
  type: TagType.End,
  parent: ElementNode | undefined
): void
/**
 * 解析开始标签 或 自闭合标签，比如 `<div id=a>` 或 <img />，得到对应的节点信息，比如标签名、属性节点、当前节点的位置信息 等
 * @param context 解析上下文
 * @param type 节点类型，开始标签？结束标签？
 * @param parent 父节点
 * @returns 
 */
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode | undefined {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  // 匹配标签名
  const start = getCursor(context)
  // 以 < 为开头，匹配 0 个或 1 个 /，匹配以空白字符开头的 /> 任意多个，比如：<div>、</div> <img />
  // match[0] 是一个完整匹配，比如 <div，match[1] 是第一个分组，即标签名
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  // 标签名
  const tag = match[1]
  // 获取标签的命名空间
  const ns = context.options.getNamespace(tag, parent)

  // 切掉字符串模版中的开始标签，比如 <div，并调整位置信息
  advanceBy(context, match[0].length)
  // 切掉 context.source 中开头位置的空白字符，并调整位置信息
  advanceSpaces(context)

  // 保存上下文中的当前状态（游标、模版字符串），以防止需要重新解析 v-pre 属性
  // save current state in case we need to re-parse attributes with v-pre
  const cursor = getCursor(context)
  const currentSource = context.source

  // check <pre> tag
  // 检查当前节点是否在 pre 节点内，如果是 更新 context.inPre 为 true
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // Attributes.
  // 解析节点上的所有属性，最终得到一个属性节点数组，每个元素都是一个属性节点（普通属性节点、指令属性节点）
  let props = parseAttributes(context, type)

  // check v-pre，如果节点含有 v-pre 指令，则重新解析属性
  // 开始节点 && 当前节点不属于 v-pre 指令所在节点的后代节点 && 当前节点存在 v-pre 指令
  // 这里大家可能会有人有疑问，为什么需要重新解析，而不是直接基于刚才解析的得到结果进行过滤，结果不都一样吗？
  // 答案是不一样，因为重新解析的时候上下文中的 inVPre 属性由 false 变为了 true，即刚才的解析过程是按照普通元素来解析的，
  // 而 v-pre 指令所在的节点以及它的子节点都不需要编译，原样渲染即可，所以需要重新解析
  if (
    type === TagType.Start &&
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    // 更新 inVPre 属性，这样当前节点的后代节点就知道自己的祖先节点是否含有 v-pre 指令
    context.inVPre = true
    // reset context
    // 用上面备份的游标信息和模版字符串重置上下文
    extend(context, cursor)
    context.source = currentSource
    // 重新解析当前节点的属性，并且过滤出 v-pre 属性节点
    // re-parse attrs and filter out v-pre itself
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  // 切除模版字符串中标签的闭合部分
  let isSelfClosing = false
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    // 是否是自闭合标签
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    // 切掉标签的闭合部分（自闭合标签的 /> 或 开始标签的 >）
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  // 如果当前处理的是闭合标签， 则直接结束
  if (type === TagType.End) {
    return
  }

  // 2.x deprecation checks
  if (
    __COMPAT__ &&
    __DEV__ &&
    isCompatEnabled(
      CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
      context
    )
  ) {
    let hasIf = false
    let hasFor = false
    for (let i = 0; i < props.length; i++) {
      const p = props[i]
      if (p.type === NodeTypes.DIRECTIVE) {
        if (p.name === 'if') {
          hasIf = true
        } else if (p.name === 'for') {
          hasFor = true
        }
      }
      if (hasIf && hasFor) {
        warnDeprecation(
          CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
          context,
          getSelection(context, start)
        )
        break
      }
    }
  }

  // 设置元素类型
  let tagType = ElementTypes.ELEMENT
  if (!context.inVPre) {
    if (tag === 'slot') {
      tagType = ElementTypes.SLOT
    } else if (tag === 'template') {
      if (
        props.some(
          p =>
            p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name)
        )
      ) {
        tagType = ElementTypes.TEMPLATE
      }
    } else if (isComponent(tag, props, context)) {
      tagType = ElementTypes.COMPONENT
    }
  }

  // 返回标签节点
  return {
    // 节点类型
    type: NodeTypes.ELEMENT,
    // 命名空间
    ns,
    // 标签名
    tag,
    // 标签类型
    tagType,
    // 属性节点数组
    props,
    // 是否为自闭合标签
    isSelfClosing,
    // 当前节点的所有子节点
    children: [],
    // 当前节点的位置信息
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

function isComponent(
  tag: string,
  props: (AttributeNode | DirectiveNode)[],
  context: ParserContext
) {
  const options = context.options
  if (options.isCustomElement(tag)) {
    return false
  }
  if (
    tag === 'component' ||
    /^[A-Z]/.test(tag) ||
    isCoreComponent(tag) ||
    (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
    (options.isNativeTag && !options.isNativeTag(tag))
  ) {
    return true
  }
  // at this point the tag should be a native tag, but check for potential "is"
  // casting
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.name === 'is' && p.value) {
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
          __COMPAT__ &&
          checkCompatEnabled(
            CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
            context,
            p.loc
          )
        ) {
          return true
        }
      }
    } else {
      // directive
      // v-is (TODO Deprecate)
      if (p.name === 'is') {
        return true
      } else if (
        // :is on plain element - only treat as component in compat mode
        p.name === 'bind' &&
        isStaticArgOf(p.arg, 'is') &&
        __COMPAT__ &&
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context,
          p.loc
        )
      ) {
        return true
      }
    }
  }
}

/**
 * 解析节点上的所有属性，最终得到一个属性节点数组，每个元素都是一个属性节点（普通属性节点、指令属性节点）
 * @param context 解析上下文
 * @param type 节点类型，开始节点 or 结束节点
 * @returns 
 */
function parseAttributes(
  context: ParserContext,
  type: TagType
): (AttributeNode | DirectiveNode)[] {
  const props = []
  // 属性名集合，用于属性去重
  const attributeNames = new Set<string>()
  // 遍历字符串模版，直到字符串模版长度为 0 || 模版以 > 或 /> 开始 时跳出循环
  // 比如 id="app">
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    // 异常情况，比如：/其它字符
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    // 异常情况，结束标签没有属性，不需要解析
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    // 解析当前属性，最终得到一个属性节点（普通的属性节点、指令节点）
    const attr = parseAttribute(context, attributeNames)

    // 如果得到的是普通的属性节点，并且是 class 属性，则处理 class 属性值中多余的空白字符
    // Trim whitespace between class
    // https://github.com/vuejs/core/issues/4251
    if (
      attr.type === NodeTypes.ATTRIBUTE &&
      attr.value &&
      attr.name === 'class'
    ) {
      attr.value.content = attr.value.content.replace(/\s+/g, ' ').trim()
    }

    // 如果当前处理的节点是开始节点，则将属性节点 push 到 props 数组中
    if (type === TagType.Start) {
      props.push(attr)
    }

    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }
    // 切掉字符串模版中的空白字符，并调整位置信息
    advanceSpaces(context)
  }
  // 返回解析得到的所有属性节点
  return props
}

/**
 * 解析节点属性，最终得到一个属性节点（普通的属性节点、指令节点）
 * @param context 解析上下文
 * @param nameSet 存放属性名的 set 结合
 * @returns 
 */
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  // 匹配属性名
  const start = getCursor(context)
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  const name = match[0]

  // 属性名重复性检测
  if (nameSet.has(name)) {
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  // 将属性名添加到集合中
  nameSet.add(name)

  // 异常情况，属性名前出现了 =，比如 <div =id="test">
  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  // 异常检测
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  // 从模版字符串中切掉属性名，并更新上下文中的位置信息
  advanceBy(context, name.length)

  // Value
  // 匹配属性值，并将属性值从模版中切掉
  let value: AttributeValue = undefined

  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    advanceSpaces(context)
    advanceBy(context, 1)
    advanceSpaces(context)
    value = parseAttributeValue(context)
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  // 当前节点的位置信息
  const loc = getSelection(context, start)

  // 如果当前节点不是 v-pre 指令所在节点的后代节点 && 当前属性是以 v-xx、:、.、@、# 等字符开头的属性
  if (!context.inVPre && /^(v-[A-Za-z0-9-]|:|\.|@|#)/.test(name)) {
    const match =
      /(?:^v-([a-z0-9-]+))?(?:(?::|^\.|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(
        name
      )!

    // 属性名以 . 开头？好像没见过这种写法
    let isPropShorthand = startsWith(name, '.')
    // 匹配指令名，结果可能是：自定义的指令名、bind、on、slot、undefined
    let dirName =
      match[1] ||
      (isPropShorthand || startsWith(name, ':')
        ? 'bind'
        : startsWith(name, '@')
        ? 'on'
        : 'slot')
    
    // 构建表达式节点
    let arg: ExpressionNode | undefined

    // 比如 v-bind:title="test title"，match[1] 为 bind、match[2] 为 title
    if (match[2]) {
      // 是否为 v-slot 指令
      const isSlot = dirName === 'slot'
      // 指令后的属性名在整个属性中的索引位置，比如 title 在 v-bind:title 中的索引位置
      const startOffset = name.lastIndexOf(match[2])
      // 节点的位置信息
      const loc = getSelection(
        context,
        getNewPosition(context, start, startOffset),
        getNewPosition(
          context,
          start,
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        )
      )
      // 属性名，比如 title
      let content = match[2]
      // 是否为静态
      let isStatic = true

      // 判断是否为静态属性，比如 v-bind:[title] 就是动态属性，如果为动态属性则切出属性名
      if (content.startsWith('[')) {
        isStatic = false

        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
          content = content.slice(1)
        } else {
          content = content.slice(1, content.length - 1)
        }
      } else if (isSlot) {
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        content += match[3] || ''
      }

      // 表达式节点
      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content,
        isStatic,
        constType: isStatic
          ? ConstantTypes.CAN_STRINGIFY
          : ConstantTypes.NOT_CONSTANT,
        loc
      }
    }

    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    // 修饰符
    const modifiers = match[3] ? match[3].slice(1).split('.') : []
    if (isPropShorthand) modifiers.push('prop')

    // 2.x compat v-bind:foo.sync -> v-model:foo
    if (__COMPAT__ && dirName === 'bind' && arg) {
      if (
        modifiers.includes('sync') &&
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_V_BIND_SYNC,
          context,
          loc,
          arg.loc.source
        )
      ) {
        dirName = 'model'
        modifiers.splice(modifiers.indexOf('sync'), 1)
      }

      if (__DEV__ && modifiers.includes('prop')) {
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_V_BIND_PROP,
          context,
          loc
        )
      }
    }

    // 返回指令节点
    return {
      type: NodeTypes.DIRECTIVE,
      name: dirName,
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        // Treat as non-constant by default. This can be potentially set to
        // other values by `transformExpression` to make it eligible for hoisting.
        constType: ConstantTypes.NOT_CONSTANT,
        loc: value.loc
      },
      arg,
      modifiers,
      loc
    }
  }

  // missing directive name or illegal directive name
  if (!context.inVPre && startsWith(name, 'v-')) {
    emitError(context, ErrorCodes.X_MISSING_DIRECTIVE_NAME)
  }

  // 返回属性节点
  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      loc: value.loc
    },
    loc
  }
}

function parseAttributeValue(context: ParserContext): AttributeValue {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0]
  const isQuoted = quote === `"` || quote === `'`
  if (isQuoted) {
    // Quoted value.
    advanceBy(context, 1)

    const endIndex = context.source.indexOf(quote)
    if (endIndex === -1) {
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      advanceBy(context, 1)
    }
  } else {
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  return { content, isQuoted, loc: getSelection(context, start) }
}

/**
 * 从字符串模版的当前位置解析出插值表达式，并调整解析上下文，然后返回插值节点
 * @param context 解析上下文
 * @param mode 解析模式
 * @returns 
 */
function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  // 界定符，默认为 {{}}
  const [open, close] = context.options.delimiters
  __TEST__ && assert(startsWith(context.source, open))

  // }} 的位置索引
  const closeIndex = context.source.indexOf(close, open.length)
  // 异常情况
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  // 从上下文中得到当前开始位置
  const start = getCursor(context)
  // 切掉 context.source 中的 {{，并调整位置信息
  advanceBy(context, open.length)
  // 当前位置，即插值的起始位置，{{起始位置}}
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)
  // 插值字符的长度，{{rawContentLength}}
  const rawContentLength = closeIndex - open.length
  // 插值内容，{{rawContent}}
  const rawContent = context.source.slice(0, rawContentLength)
  // 插值
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  // 去除插值的前后空白字符
  const content = preTrimContent.trim()
  // 插值前面的空白字符长度，{{空白字符content}}
  const startOffset = preTrimContent.indexOf(content)
  // 如果有空白字符，则根据要切掉的字符数量（startOffset），更新上下文中的位置信息（偏移量、行号、列号）
  if (startOffset > 0) {
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  // 同上
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  // 从 context.source 中切除整个插值表达式，并调整位置信息
  advanceBy(context, close.length)

  // 返回插值节点
  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      // Set `isConstant` to false by default and will decide in transformExpression
      constType: ConstantTypes.NOT_CONSTANT,
      content,
      loc: getSelection(context, innerStart, innerEnd)
    },
    loc: getSelection(context, start)
  }
}

/**
 * 从字符串模版的当前位置开始解析出第一个结束标签之前的文本内容，然后返回文本节点
 * @param context 解析上下文
 * @param mode 解析模式
 * @returns 
 */
function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  // 不同模式有不同的结束标志
  const endTokens =
    mode === TextModes.CDATA ? [']]>'] : ['<', context.options.delimiters[0]]

  // 字符串模版中有效结束标志的索引位置，默认为字符串末尾
  let endIndex = context.source.length
  // 从字符串模版中找到最靠前的结束位置
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)
    if (index !== -1 && endIndex > index) {
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  // 开始位置
  const start = getCursor(context)
  // 解析得到指定长度的文本
  const content = parseTextData(context, endIndex, mode)

  // 返回文本节点
  return {
    // 节点类型
    type: NodeTypes.TEXT,
    // 文本内容
    content,
    // 节点在字符串模版中的位置信息
    loc: getSelection(context, start)
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 * 从当前位置获取指定长度的字符文本，并调整解析上下文中的位置信息和 source
 * @param context 解析上下文
 * @param length 解析的字符的长度
 * @param mode 解析模式
 * @returns 
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  // 剪切指定长度字符
  const rawText = context.source.slice(0, length)
  // 调整 content.source，将 rawText 部分切掉，并更新对应的位置信息
  advanceBy(context, length)
  // RAWTEXT || CDATA || 不含字符实体，则返回原字符串，否则将字符实体转换后再返回
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    !rawText.includes('&')
  ) {
    return rawText
  } else {
    // DATA or RCDATA containing "&"". Entity decoding required.
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

// 获取当前游标信息（行列号、偏移量）
function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

/**
 * 获取当前节点在字符串模版中的位置信息，比如开始位置、结束位置、模版内容
 * @param context 上下文
 * @param start 开始位置的游标信息
 * @param end 结束位置的游标信息
 * @returns 
 */
function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

// 从参数数组中获取最后一个元素
function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

/**
 * 从模版字符串的开头位置截掉指定数量的字符，并更新上下文中的位置信息
 * @param context 解析上下文
 * @param numberOfCharacters 要删掉的字符数量
 */
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)
  // 根据要切掉的字符数量，更新上下文中的位置信息（偏移量、行号、列号）
  advancePositionWithMutation(context, source, numberOfCharacters)
  context.source = source.slice(numberOfCharacters)
}

/**
 * 切掉 context.source 中开头位置的空白字符，并调整位置信息
 * @param context 解析上下文
 */
function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

/**
 * 判断是否解析到了闭合标签（结束位置），不同模式的判断标准不一样
 * 1. DATA 状态，如果能从 ancestors 数组找到对应的开始节点，则认为匹配到了闭合标签
 * 2. RCDATA 和 RAWTEXT 状态下，如果 ancestors 数组的最后一个元素是对应的开始标签，则认为匹配到了闭合标签
 * 3. CDATA 状态下，如果字符串模版是以 ]]> 开头，则认为匹配到了 CDATA 的闭合标签
 * 4. 如果 source 为空，则认为匹配结束
 * @param context 解析上下文
 * @param mode 目前所处的解析状态（模式），不同状态的解析机制不一样
 * @param ancestors 存放当前解析节点的所有祖代节点
 * @returns 
 */
function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  // 字符串模版
  const s = context.source

  //
  switch (mode) {
    // DATA 状态，如果能从 ancestors 数组中匹配到对应的开始标签，则认为是到了末尾
    case TextModes.DATA:
      if (startsWith(s, '</')) {
        // TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) {
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    // RCDATA 和 RAWTEXT 状态下，看 ancestors 数组的最后一个元素是否是对应的开始标签，如果是则认为是到了末尾
    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    // CDATA 状态下，如果模版字符串是以 ]]> 开头的，则认为是匹配到了 CDATA 的闭合标签
    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  // 如果上述状态否不符合，如果字符串模版为空，则认为是到了末尾
  return !s
}

/**
 * 判断 tag 是否为模版字符串开头字符的开始标签
 * @param source 字符串模版，比如 </tag>
 * @param tag 标签名
 * @returns 
 */
function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') &&
    source.slice(2, 2 + tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\r\n\f />]/.test(source[2 + tag.length] || '>')
  )
}
