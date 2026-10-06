
# 1. 验证远程仓库

`ssh -T git@github.com`

# 2. 查看当前远程仓库

```Shell
git remote -v
```

# 3.1 如果没有显示 `Tonyfield/VoiceCloner`，就添加：

## 3.1.1 使用 HTTPS

git remote add origin https://github.com/Tonyfield/VoiceCloner.git

## 3.1.2 或者使用 SSH（需已配置 SSH key）

```Shell
git remote add origin git@github.com:Tonyfield/VoiceCloner.git
```

# 3.2 如果已有 `origin` 但指向别处，先修改：

```Shell
git remote set-url origin git@github.com:Tonyfield/VoiceCloner.git
```

# 4. 提交本地改动

```Shell
git add .
git commit -m "你的提交说明"
```
