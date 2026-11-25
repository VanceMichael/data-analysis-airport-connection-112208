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
- `rebook_updates.json` 记录字段为 `ticket`、`from`、`to`、`at`、`status`。
- `accounting.json` 记录字段为 `claim`、`expense`、`carrier`、`tickets`、`amount`、`service_period`、`received_period`、`state`。
- `rooms.json` 记录字段为 `receipt`、`room_key`、`guests`、`amount`、`bill`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 归因与分账工具

工具只读 `data/`，不回写任何输入；每结完一批联程可用同一批资料复跑，结果确定可重现。

```sh
node bin/cli.js ticket <票证号>          # 单行：时间窗口、反事实模拟、责任份额、改签与冲突证据
node bin/cli.js periods [--period P1]    # 周期：费用总额、已归因、共同费用、未结原因、核对
node bin/cli.js diff <期A> <期B>         # 原期冻结签数 + 送达期应补/抵消/复议差额分列
node bin/cli.js report                   # 全量可解释报告；加 --json 输出机读结果
```

### 判定口径（与业务协议对应）

1. **保护义务**：按票证 `rule` 与公布的 `min_transfer` 预先认定；实际能否衔接只看证据重建——
   到位、开门、接驳完成、关门。未提供的时间以 `earliest/latest` 上下界表达，区间跨越关门判为
   `unknown`（证据不足），只靠最后到达不推断可控段；恰在关门时完成（`<=`）仍可衔接。
   同一事件多版 `revision` 以最高版本为当前值，各版区间不相交才记为证据矛盾（rev1 区间被 rev2
   精确值细化且落在界内不算矛盾）。
2. **反事实模拟**：仅采用适用于本票证规则、且作用于其前后段航班的反事实证据；关门/开门基准为
   绝对分钟，接驳基准为开门起的分钟差。枚举单项与全部组合消除方案：
   - 任一单项消除即可恢复 → `single`，独立可恢复方按协议均分；
   - 必须同时消除若干项 → `combined`，取全部最小充分集合的共同必要方均分；无共同必要方转暂挂；
   - 无证据或全部方案均不能证明可恢复（含证据矛盾）→ `unresolved`，费用份额暂挂。
3. **改签**：替代段开门前可改变选择（换票时刻严格早于开门），过门后的换票不生效、原改签锁定为
   实际花费；接受一份可行改签后其余同类报价报销资格关闭；替代段也可能错接，但此前已发生住宿不失效。
4. **保障开支**：酒店按房结，一房多人按入住旅客拆份额；关联旅客责任未定时其份额暂挂，不得把全间
   判给同房另一旅客的责任方，也不按人头重复支出。已付旅客的钱不重付；合作方差额走复议回单；
   未达用证条件的部分保持暂挂。
5. **回单**：先行垫付单独登记；另一家就同一房账申领时，只有同收据同房号（同一实际住宿）才抵消
   重复申领；同账单不同房号是另一份真实费用，不得被同一费用号抹掉。跨期送达的凭据按送达期做
   调整入账，原服务期已签数字不重开，`diff` 可分别查冻结签数与本期调整。

### 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/timeline.js` | 事件窗口重建、版本/顺序矛盾检验、衔接判定（含上下界） |
| `src/simulation.js` | 反事实证据匹配、单项与组合消除模拟、三类责任归类 |
| `src/responsibility.js` | 按 K1/K2 协议条款生成责任方份额与暂挂说明 |
| `src/rebooks.js` | 改签报价资格、开门前后换票有效性、实际花费认定 |
| `src/costing.js` | 按房分摊、回单抵消/复议/暂挂、周期台账与核对 |
| `src/engine.js` | 总装并输出票证、费用、回单、周期与冲突证据 |
| `bin/cli.js` | 命令行入口（文本/`--json`） |
| `test/engine.test.js` | 22 项业务规则测试（含矛盾证据、组合责任、跨期等构造场景） |
