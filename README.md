# 联程改签的误机归因和保障成本复议

时刻是当地时间自零点起的分钟数。样本只含合成行程，室号是匿名凭据。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

K1 和 K2 的最短衔接承诺用于预先认定接续保护，之后能否实际衔接由开门、完成接驳及关门时间判断，恰在关门时完成仍可衔接。替换证据表里的关门或开门基准为绝对分钟，接驳基准为从开门起的分钟差。责任未定的票按共享人数暂挂其费用份额。

- `trips.json` 记录字段为 `ticket`、`group`、`inbound`、`outbound`、`carrier`、`rule`、`min_transfer`。
- `legs.json` 记录字段为 `flight`、`event`、`at`、`earliest`、`latest`、`revision`、`cause`。
- `counterfactual.json` 记录字段为 `cause`、`affected`、`reference`、`rule`。
- `rebooks.json` 记录字段为 `rebook`、`ticket`、`flight`、`state`、`compensation`。
- `expenses.json` 记录字段为 `receipt`、`type`、`tickets`、`cost`、`state`。
- `agreements.json` 记录字段为 `rule`、`single`、`combined`、`unresolved`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
