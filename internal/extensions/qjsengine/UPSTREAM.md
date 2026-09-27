# QJS 上游适配器

此包包含 [`github.com/fastschema/qjs` v0.0.6](https://github.com/fastschema/qjs/tree/v0.0.6)（commit `461716f4f380f81ffd09378751f1812919cddbca`）的非测试 Go 源码和嵌入式 `qjs.wasm`，遵循 MIT License。上游许可文本位于 `LICENSE`。

Modelry 的本地改动范围如下：

- 将宿主目录 `WithDirMount` 替换为空的只读内存 `fs.FS`，挂载在 Guest `/`；
- 始终启用 Wazero 上下文取消，并将线性内存限制为 2,048 页（128 MiB）；
- Wazero 关闭模块后跳过 Guest 值清理，将中断时 `Eval` 的 panic 转为通用错误，并关闭每次调用使用的 Wazero Runtime；
- 每次 Extension 调用创建全新 Runtime，取消后的实例绝不复用或放入池中。

升级或重新生成此包前，必须先重新运行 `runtime_test.go` 中的文件系统、内存上限、取消和跨平台测试，并审阅上游 WASM shim。此适配器仅供内部使用，不定义 Modelry 的公开 Extension API。
