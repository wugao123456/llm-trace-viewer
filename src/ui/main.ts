/**
 * UI 入口文件
 * 
 * 应用启动流程：
 * 1. 导入 app.ts，注册自定义元素 trace-app
 * 2. 浏览器解析 index.html，自动实例化 trace-app 组件
 * 3. 组件挂载后触发 connectedCallback，初始化主题和检查保存的文件
 * 
 * 注意：应用通过自定义元素机制自动初始化，无需手动创建实例
 */

import "./app.js";

console.log("LLM Trace Viewer loaded");