// Runtime stub for the "obsidian" module, used only by vitest.
// Only the shapes touched at module-load / class-definition time matter.
class Plugin {
  register() {}
  registerEvent() {}
  addSettingTab() {}
  async loadData() { return null; }
  async saveData() {}
}
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; }
}
class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
}
function debounce(fn) {
  const wrapped = (...args) => fn(...args);
  wrapped.cancel = () => wrapped;
  wrapped.run = () => {};
  return wrapped;
}

module.exports = { Plugin, PluginSettingTab, Setting, debounce };
