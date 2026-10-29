import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  InputProps,
  MarkdownProps,
  TextProps,
} from 'claude-code'

export const PANE = 'office'
export const TITLE = 'Office'

const DETAIL_PREFIX = 'office-'

export const detailPaneId = (agentId: string) => `${DETAIL_PREFIX}${agentId}`

export const agentOfPane = (requestId?: string) =>
  requestId?.startsWith(DETAIL_PREFIX) ? requestId.slice(DETAIL_PREFIX.length) : undefined

export type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input?: ElementConstructor<InputProps>
  Markdown: ElementConstructor<MarkdownProps>
  Code: ElementConstructor<CodeProps>
}

const plain = (text: string) => text.replace(/[*_`#>]+/g, '').trim()

export const firstLine = (text: string) => plain(text.split('\n').find(line => plain(line)) ?? '')

export const relativePaths = (text: string, root: string) => (root ? text.split(`${root}/`).join('') : text)
