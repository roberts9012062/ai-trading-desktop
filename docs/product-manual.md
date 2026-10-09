# 周期领航使用手册

客户端菜单新增“使用手册”，内置章节文字，截图来自同版本实际桌面界面，由 https://b.00n.top/manual 提供。
官网产品页：https://b.00n.top/ 。网页版手册：https://b.00n.top/manual 。网页管理员：https://b.00n.top/admin 。

内容源位于服务端项目 frontend/src/lib/manual-content.ts、frontend/src/components/product/manual-reader.tsx 及两份 CSS。更新手册后将这些文件同步到桌面端同路径，并完成版本递增、GitHub 提交与 tag 发布。
发布 v0.2.151：增加图文手册、目录搜索、章节链接、截图放大与前后章节导航。

发布 v0.2.152：普通用户每个多周期猎手最多同时运行 3 个交易子任务，待成交与待确认退出均占用名额；管理员策略上限保持不变。

发布 v0.2.153：任务卡及三类收藏支持完整配置导入导出、导入运行选择、同币冲突提示和自动分类；加入操作章节与新界面示例截图。
