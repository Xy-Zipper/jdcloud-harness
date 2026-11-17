---
kind: upgrade-guide
description: "JDCloud 记录工具会拒绝不属于实时存储选项 id 的静态选择值。"
---

# JDCloud 静态选择必须使用存储选项 id

[English](guide.md) | 中文

## 变更

`jdcloud_lowcode_create` 和 `jdcloud_lowcode_update` 以前只检查选择值的 JSON 类型，不检查静态选项是否包含该值。现在会重新读取静态 `select`、`radio` 和 `checkbox` 选项（包括子表），在修改记录前以 `JDCLOUD_LOWCODE_FIELD_TYPE` 拒绝未知 id。`jdcloud_lowcode_describe` 新增存储选项 id 的 `enum` 数组。动态选择器保留原有行为。

## 迁移

1. 对目标菜单调用 `jdcloud_lowcode_describe`，在新增或更新数据中使用各字段的 `enum` 值，不用显示标签或自拟同义词替代。非必填单选仍可用空字符串清空。
2. 如果描述与写入之间选项发生变化，使用错误中允许的 id，或再次描述该菜单。确认合法 id 能保存、非法 id 返回 `JDCLOUD_LOWCODE_FIELD_TYPE` 且记录没有变化。该校验不会改写已有记录。
