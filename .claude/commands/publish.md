---
name: 发布
description: 发布新版本到 release 分支
category: Deployment
tags: [release, publish, version]
---

# 发布新版本

**参数**:
- `版本号` (可选，格式如 v0.1.1 或 0.1.1)

**版本号处理规则**:
- **不提供参数**: 自动升级 PATCH 版本号（最后一位，如 0.1.0 → 0.1.1）
- **提供参数**: 使用指定的版本号

**远程仓库说明**:
- `origin` — Gitea（`git.crazyamber.com/crazy.amber.studio/codex-relay.git`），部署用，监控 release 分支自动构建部署
- `github` — GitHub（`github.com/smart-kind/deno-codex-relay.git`），日常开发推送

**发布流程概要**: 当前分支 → 合并到 release → 推送 release + tag 到 **origin (Gitea)**（触发部署）→ 推送 release 到 github → 合并回当前分支并推送

## 步骤

1. **准备工作**
   - 获取当前分支名（源分支）
   - 运行 `deno task check` 进行代码校验，确保构建通过
   - 确保所有改动已提交并推送到远程仓库（不要局部提交，保证完整性）

2. **切换到 release 分支并拉取**
   ```bash
   git checkout release
   git pull origin release
   ```

3. **合并源分支到 release**
   ```bash
   git merge <源分支> -m "Merge branch '<源分支>' into release"
   ```

4. **升级版本号**
   - 读取 `deno.json` 中的当前版本
   - 如果用户提供了版本参数，使用该版本（去除 `v` 前缀）
   - 否则自动升级 PATCH 版本号（最后一位，如 0.1.0 → 0.1.1）
   - 使用 `jq` 更新 deno.json：
     ```bash
     jq '.version = "<新版本>"' deno.json > deno.json.tmp && mv deno.json.tmp deno.json
     ```

5. **提交发布**
   ```bash
   git add deno.json
   git commit -m "release: v<版本号>"
   ```

6. **推送 release 到 Gitea（触发部署）**
   ```bash
   git push origin release
   ```

7. **创建版本标签并推送到 Gitea**
   ```bash
   git tag v<版本号> -a -m "版本 v<版本号>"
   git push origin v<版本号>
   ```

8. **同步 release 到 GitHub**
   ```bash
   git push github release
   ```

9. **切换回源分支并合并 release**
   ```bash
   git checkout <源分支>
   git merge release -m "Merge branch 'release' into <源分支>"
   git push github <源分支>
   ```

## 示例

```
用户: 发布 v0.2.0
# 执行发布，版本设为 0.2.0

用户: 发布
# 自动升级 PATCH 版本号，如 0.1.0 → 0.1.1
```