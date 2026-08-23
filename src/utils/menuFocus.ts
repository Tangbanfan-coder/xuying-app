// 移动端软键盘保活：composer 工具按钮打开下拉菜单时配合 onPointerDown 的
// preventDefault() 阻止焦点离开输入框；关闭菜单后仅当输入框未持焦
// （键盘导航或桌面场景）才把焦点交还触发按钮。
export function isComposerInputFocused() {
  return document.activeElement?.tagName === 'TEXTAREA'
}

export function focusTriggerUnlessTyping(trigger: HTMLElement | null) {
  if (isComposerInputFocused()) return
  trigger?.focus()
}
