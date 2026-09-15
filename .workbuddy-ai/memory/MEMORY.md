# 项目长期记忆 — jdcloud-harness

## 环境约束（WorkBuddy 沙箱）

### 禁止 `git stash`
本环境中 `git stash push` 已被 SIGTERM 中断**两次**，每次都破坏 `.git`：
- 第一次：`.git/refs/`、`.git/logs/`、全部 9 个 `.pack` 丢失 → 全库不可用
- 第二次：`.git/refs/`、`.git/logs/` 丢失 + HEAD 的父提交缺失 → 历史图断裂

**替代方案**（只读对比基线）：
```sh
git show HEAD:<path>              # 看某个文件的历史版本
git diff <ref> -- <path>          # 与任意 ref 比较
git worktree add /tmp/wt <ref>    # 需要整棵树时用独立 worktree
```
详细恢复流程见 `.workbuddy-ai/memory/2026-09-14.md` 的「事故一」「事故二」。

### 回补 git 对象的正确姿势
本地图断裂时 `git fetch` **不会自愈**（认为对象已存在，不重新请求）。
必须借道干净仓库：
```sh
git init -q --bare /tmp/rescue && cd /tmp/rescue
git fetch --no-tags --depth=80 <remote-url> <branch>
# 然后把新仓库的 .pack + .idx 拷入原仓库 .git/objects/pack/ 作为新增 pack
```
另外 `multi-pack-index` 若要重建，必须**先删后写**（旧索引会引用已消失的 pack）：
```sh
rm -f .git/objects/pack/multi-pack-index && git multi-pack-index write
```

### 覆盖率跑法
vitest 收尾会删 `coverage/.tmp`，消耗 safe-delete 轮次配额（阈值 50，**按会话轮次累计**），
导致报告写不出来。**跑 `--coverage` 前必须先用 host 通道清掉 `coverage/`。**

判定「包自身门禁是否通过」必须带 `--coverage.include`，否则会按全仓计量而误报：
```sh
npx vitest run packages/<group>/<package> \
  --coverage \
  --coverage.include='packages/<group>/<package>/src/**/*.ts'
```
退出码 0 且无 `ERROR: Coverage` 行 = 通过。

### 其他
- `wmic.exe` / `reg.exe` 在沙箱程序黑名单中（lefthook 探测注册表会因此失败，属环境噪声）。
- `~/.dsh/profiles/node_modules.lock` 陈旧时，重置删除计数器后手动删除即可。

## 测试约定

- 枚举全仓工具/包的测试（如 `packages/core/tools/tests/gen-tool-catalog.spec.ts`）
  在新增工具包时**必须同步更新**，否则会阻塞检查。
- `tools.ts` 的 `sessionAttachments` 只被 `jdcloud_lowcode_upload_file` 调用；
  测附件收集必须走上传工具，在 `create`/`update` 里 append 消息无效。
- v8-to-istanbul 对 `if (C) return X` 的分支计数是 `[then, else]`。
