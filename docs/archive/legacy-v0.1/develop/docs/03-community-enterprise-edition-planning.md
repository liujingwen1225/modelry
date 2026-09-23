# Modelry Community / Enterprise Edition 规划

## 状态

**Planning — Deferred until V0.1.0 Release**

本文档记录 Modelry 在 V0.1.0 完成后的开源版 / 商业版分层方向。

它不是当前 V0.1.0 的实现规格，不修改 `docs/01-v0.1-scope.md`、Frozen Contract、现有 ADR 或 Release Gate，也不授权任何 Enterprise 能力提前进入 V0.1.0。

正式 Edition Boundary、License、Packaging、Enterprise Architecture 必须在 V0.1.0 发布后重新评审，并通过后续 Specification / ADR 固化。

---

## 1. 为什么现在只做规划

Modelry 当前正式阶段仍是 V0.1.0 Release Readiness / Hardening。

在首个可用版本尚未完整发布前，过早为商业版切割 Core Runtime，容易造成：

- 当前 Release Scope 被商业化设计反向扩大；
- Core Runtime 出现尚无真实需求的 Edition 分支；
- 为假设中的 Enterprise 能力提前抽象；
- Community 版本被人为削弱，影响开发者 adoption；
- Single Binary、One Instance / One Project 等现有产品不变量被过早破坏。

因此当前只保留一份明确的 parking document：

> 先完成一个完整、可信、可独立使用的 Modelry V0.1.0，再决定哪些“企业规模问题”值得成为商业能力。

---

## 2. 初步产品策略

优先评估 **Open Core：Community + Enterprise**。

核心分界原则：

> **Community 解决“能否完整构建和运行一个 Modelry Backend”；Enterprise 解决“团队和企业能否安全、规模化、可治理地运营多个 Modelry Backend”。**

这意味着商业化不应建立在故意破坏 Community 的核心应用闭环之上。

### 2.1 Community 不应成为 Demo Edition

Community 应允许开发者真实完成：

```text
Model / Collection
    ↓
Record / Relation / File
    ↓
Policy / Application Auth
    ↓
REST API / OpenAPI / Realtime
    ↓
Hook / Secret / MCP
    ↓
ChangeSet / Diff / Migration / Audit
    ↓
Standalone Runtime
```

如果一个开发者必须购买商业版才能完成上述基本闭环，Edition Boundary 就需要重新评估。

### 2.2 Enterprise 主要出售“组织级复杂度”

Enterprise 的价值优先来自：

- Organization / Team Governance；
- Enterprise Identity；
- Security / Compliance；
- Centralized Audit；
- Fleet / Multi-instance Operations；
- HA / Scale；
- Backup / Disaster Recovery；
- Enterprise Integrations；
- Commercial Support / SLA。

这些问题通常只有团队、组织或生产规模扩大后才明显出现。

---

## 3. 当前产品不变量如何延续

Edition 设计不能绕开 Modelry 已确认的产品不变量。

### 3.1 Human and Agent share one Backend semantics

Enterprise 不创建第二套 Backend Model，也不让企业控制台绕过 ChangeSet / Diff / Apply / Audit。

### 3.2 AI Native, Not AI Dependent

Community 和 Enterprise 的核心 Runtime 都不能依赖 AI Provider 才能正常运行。

### 3.3 Explicit over Magic

企业审批、策略、变更治理、审计能力如果存在，也必须建立在显式变更事实之上，而不是隐藏式管理通道。

### 3.4 One Instance, One Project

当前不变量保持：

`One Instance -> One Project`

未来即使 Enterprise 引入 Organization、Workspace 或 Multi-project 管理，也优先采用：

```text
Enterprise Control Plane
├── Project A -> Instance A
├── Project B -> Instance B
└── Project C -> Instance C
```

而不是立即把单个 Runtime 改造成：

```text
One Instance
├── Project A
├── Project B
└── Project C
```

是否改变 `One Instance, One Project` 必须单独通过 ADR，不因“商业版需要多项目”而默认修改。

### 3.5 Data Plane / Control Plane 分离

Enterprise Identity、Organization RBAC、Admin Governance 属于 Control Plane。

Application Auth、Auth Collection、Record Policy 继续属于 Application Data Plane。

商业版不能用 Enterprise SSO 取代 Application Auth，也不能把二者混成一套身份模型。

---

## 4. Community Edition 初步边界

Community 的目标用户仍然与当前产品定义一致：

- AI Coding 开发者；
- 独立开发者；
- 需要轻量自托管 Backend 的应用开发者；
- 小型团队。

### 4.1 应保持完整的 Core Runtime

以下能力原则上不应因为 Edition 分层被移出 Community：

#### Backend Model

- Normal Collection；
- Auth Collection；
- Field；
- Relation；
- Index；
- Validation；
- Default；
- Policy。

#### Data Plane

- Record CRUD；
- Filter / Sort / Pagination；
- Relation Expand；
- Application Auth；
- File；
- Realtime；
- REST API；
- OpenAPI。

#### Runtime / Change Management

- Backend Model Inspect；
- ChangeSet；
- Structured Diff；
- Risk；
- Apply Attempt；
- Migration；
- Recovery；
- Drift / Doctor 基础能力；
- Lifecycle Hook；
- Secret；
- Domain Event / Audit 基础事实。

#### Developer Interfaces

- Admin UI；
- CLI；
- MCP；
- SDK / machine-readable contract。

### 4.2 Community 的部署定位

初步保持：

> **Single Binary First + Single Project Runtime + Self-hosted**

V0.x 继续遵守现有 SQLite First 约束。

后续 Community 是否支持其他数据库、更多对象存储、容器化部署等，应按独立产品价值判断，而不是简单以“企业会使用”为理由全部放入商业版。

### 4.3 不建议采用的限制方式

原则上不建议通过以下人为额度制造 Enterprise 价值：

- 最多 N 个 Collection；
- 最多 N 条 Record；
- 最多 N 个 Relation；
- Policy 只能商业版使用；
- Auth 只能商业版使用；
- Migration / Backup 的最基本可恢复能力完全商业化；
- MCP / OpenAPI 等 Modelry 核心差异化能力收费解锁。

如果未来 Cloud Hosted Edition 需要按 Usage 计费，这是 Hosted Service 的商业模型问题，不应自动转化为 Self-hosted Community 的功能阉割。

---

## 5. Enterprise Edition 候选能力域

以下仅为 V0.1.0 后的候选商业化范围，不代表已经 Accepted。

### 5.1 Organization & Collaboration

候选能力：

- Organization；
- Workspace；
- Team；
- Member；
- 多 Project / 多 Instance 集中管理；
- Environment Management；
- Custom Role；
- Fine-grained Control Plane RBAC；
- Approval Workflow；
- Change Review；
- Environment Promotion。

核心目标：

> 管理“谁可以在什么组织、项目、环境中做什么”，而不是改变单个 Project 的业务数据模型。

---

### 5.2 Enterprise Identity

候选：

- SSO；
- OIDC Enterprise IdP；
- SAML；
- LDAP；
- SCIM；
- Organization Login Policy；
- Admin MFA Policy；
- Session Governance；
- Just-in-time Provisioning。

必须保持边界：

```text
Enterprise Identity
    ↓
Control Plane Principal
    ↓
Admin / Agent Capability

Application Auth
    ↓
Auth Collection Record
    ↓
Application Principal
    ↓
Record Policy
```

两条身份链不能互相替代。

---

### 5.3 Security & Governance

候选：

- Fine-grained Admin RBAC；
- IP / Network Access Policy；
- Secret Governance；
- Change Approval；
- Migration Approval；
- Policy Change Review；
- Security Baseline；
- Compliance Evidence；
- Retention Policy；
- Administrative Access Review。

Enterprise 可以增强治理，但不能创建绕过 Core Policy / ChangeSet 的隐藏操作路径。

---

### 5.4 Advanced Audit

Community 应保留用于理解和诊断 Runtime 的基础 Audit Facts。

Enterprise 候选提供：

- 长期审计保留；
- 不可篡改或外部留存；
- Organization-wide Audit；
- 跨 Instance 查询；
- Audit Export；
- SIEM Integration；
- Compliance Report；
- Admin Access Audit；
- Change Approval Trail。

初步分界不是：

`Community 无审计 / Enterprise 有审计`

而是：

`Community 有真实运行审计事实 / Enterprise 有组织级审计治理`

---

### 5.5 Scale & High Availability

这是最自然的商业边界候选之一。

Enterprise 候选：

- Multi-node Runtime；
- HA；
- Horizontal Scaling；
- Shared Runtime State；
- Runtime Failover；
- Rolling Upgrade；
- Zero-downtime Upgrade；
- Fleet Management；
- Resource Quota；
- Capacity Management。

但不得在 V0.1.0 前为假设中的 Cluster 提前制造复杂分布式抽象。

---

### 5.6 Backup / Recovery / Disaster Recovery

Community 必须至少能够以明确方式完成数据备份和恢复，否则无法成为真实可用的 Self-hosted Backend。

Enterprise 候选增强：

- Scheduled Backup；
- Centralized Backup Policy；
- PITR；
- Cross-region Copy；
- Disaster Recovery；
- Restore Drill；
- Retention Policy；
- Organization-wide Recovery Dashboard。

最终边界需在 V0.1.0 发布后结合真实 Backup / Restore 设计决定。

---

### 5.7 Enterprise Secret / Key Integration

Community 可以继续拥有自身真实可用的 Secret Runtime。

Enterprise 候选 Provider：

- HashiCorp Vault；
- AWS KMS / Secrets Manager；
- GCP KMS / Secret Manager；
- Azure Key Vault；
- Enterprise HSM / KMS Integration。

其设计目标应是扩展 `SecretProvider` 或等价边界，而不是复制第二套 Secret 领域模型。

---

### 5.8 Observability

Community 应具备足够的：

- Health；
- Runtime Status；
- Logs；
- Basic Metrics / Diagnostics。

Enterprise 候选：

- Centralized Metrics；
- OpenTelemetry 集成；
- Distributed Tracing；
- Organization-wide Dashboard；
- Alerting；
- SLA / SLO；
- Audit + Metrics Correlation；
- Fleet Health。

具体哪些标准协议进入 Community，不在本文档提前锁死。

---

### 5.9 Enterprise Integrations

候选：

- SIEM；
- Kafka / Event Bus；
- Enterprise Webhook Management；
- External IdP；
- KMS / Vault；
- Centralized Object Storage Policy；
- Enterprise Proxy / Network Policy；
- Ticket / Approval Integration。

原则：

> Integration 可以商业化，Core Domain Semantic 不商业化。

---

### 5.10 Commercial Support

候选：

- Enterprise Support；
- SLA；
- Upgrade Assistance；
- Security Advisory；
- Architecture Review；
- Priority Fix；
- LTS Release；
- Commercial Indemnification / Contract Terms。

这是独立于代码功能之外的重要商业价值来源。

---

## 6. 初步 Edition Matrix

| 能力 | Community | Enterprise 候选 |
|---|---|---|
| Backend Model | 完整 | 完整 |
| Collection / Record / Relation | 完整 | 完整 |
| Record Policy | 完整 | 完整 + Governance |
| Application Auth | 完整 | 完整 |
| REST / OpenAPI | 完整 | 完整 |
| MCP | 完整 | 完整 + Organization Governance |
| Hook / Realtime | 完整 | 完整 + Centralized Operations |
| ChangeSet / Diff / Migration | 完整 | 完整 + Approval / Promotion |
| Basic Audit Facts | 是 | 是 |
| Organization-wide Audit | 否 | 候选 |
| Single Project Runtime | 是 | 是 |
| Organization / Team | 否 | 候选 |
| Enterprise Control Plane RBAC | 否 | 候选 |
| SSO / SAML / SCIM / LDAP | 否 | 候选 |
| HA / Multi-node | 否 | 候选 |
| Fleet Management | 否 | 候选 |
| Scheduled / Central Backup | 基础能力待定 | 候选 |
| PITR / DR | 否 | 候选 |
| Vault / Cloud KMS | 否 | 候选 |
| Centralized Observability | 否 | 候选 |
| SIEM / Compliance Export | 否 | 候选 |
| SLA / Commercial Support | Community Support | 候选 |

该表只是后续评审起点，不是 License Contract。

---

## 7. Edition Architecture 原则

### 7.1 唯一 Core Runtime

优先目标：

```text
              Enterprise Capabilities
                     │
    ┌────────────────┼────────────────┐
    │                │                │
Identity        Governance          Ops
Audit           Approval            HA
KMS             Organization        Backup
    │                │                │
    └────────────────┼────────────────┘
                     ▼
              Modelry Core Runtime
```

不建议形成：

```text
Community Runtime
Enterprise Runtime
```

两套长期分叉的领域实现。

### 7.2 Enterprise 不得复制 Core Domain

例如：

- 不创建 Enterprise Record Store；
- 不创建 Enterprise Policy Engine；
- 不创建 Enterprise Migration Engine；
- 不创建 Enterprise Secret Domain；
- 不创建 Enterprise Auth Collection。

Enterprise 应扩展治理、Provider、部署或组织层能力。

### 7.3 Capability / Provider 扩展点

V0.1.0 发布后，应评估现有 Runtime 是否真的需要正式扩展边界。

候选包括：

- `IdentityProvider`；
- `SecretProvider`；
- `StorageProvider`；
- `AuditSink`；
- `ObservabilityProvider`；
- `BackupProvider`；
- `ControlPlaneAuthorizationProvider`。

但遵守现有工程原则：

> 只有出现第二个真实实现和明确需求时才抽象，不为未来 Enterprise 预先制造只有一个实现的通用 Adapter。

---

## 8. Repository 与 Packaging 候选

V0.1.0 后再正式选择。

### 8.1 候选 A：Core / Enterprise 分仓

示意：

```text
modelry/
├── core
├── runtime
├── admin
├── cli
└── sdk

modelry-enterprise/
├── organization
├── enterprise-identity
├── governance
├── audit
├── fleet
├── backup
└── integrations
```

优点：

- 开源与商业 License 边界清晰；
- Enterprise 源码隔离直接；
- Community 仓库保持完整。

需要解决：

- Extension Contract；
- Version Compatibility；
- Build / Packaging；
- Single Binary Composition；
- Upgrade Compatibility。

### 8.2 候选 B：Monorepo + License Boundary

可以降低版本协调成本，但源码与授权边界更复杂。

本文档不提前决定。

### 8.3 Single Binary 如何延续

Enterprise 不应默认迫使 Modelry 放弃 Single Binary First。

后续可评估：

- Community Binary；
- Enterprise Binary；
- Build-time Composition；
- Signed Enterprise Module；
- External Enterprise Control Plane + unchanged Runtime Agent。

最终方案需要独立 ADR。

---

## 9. License 初步方向

当前仅保留候选，不在 V0.1.0 前确定。

### 9.1 Community

优先评估宽松开源 License，例如：

- Apache-2.0。

理由：

- 降低早期采用门槛；
- 方便企业内部试用；
- 有利于 SDK / Integration / Plugin 生态；
- 与开发者工具增长目标一致。

### 9.2 Enterprise

商业 License。

### 9.3 后续再评估的问题

如果未来出现明显的第三方直接托管竞争，再评估：

- AGPL；
- BSL；
- Source Available；
- Cloud Service Restriction。

不要在尚未验证 adoption 前因为假设中的云厂商竞争增加 Community 使用摩擦。

---

## 10. Pricing 暂不绑定技术边界

Edition Architecture 与 Pricing 不应混为一件事。

未来可能的商业维度包括：

- Organization；
- Admin Seat；
- Managed Instance；
- Runtime Node；
- Enterprise Feature Pack；
- Support Tier；
- Hosted Usage。

但 Self-hosted Community 不建议简单使用 Record / Collection 数量作为商业锁。

正式 Pricing 必须基于真实用户和成本数据，而不是由代码结构倒推。

---

## 11. V0.1.0 前明确禁止的动作

在 V0.1.0 发布前，不因为本文档：

- 创建 License Server；
- 创建 License Key Runtime；
- 在 Core 中增加大量 `if enterprise`；
- 创建 Enterprise Runtime；
- 引入 Organization；
- 引入 Multi-project Runtime；
- 引入 SSO / SAML / SCIM；
- 引入 HA / Cluster；
- 引入 PostgreSQL；
- 引入商业计费；
- 修改 Frozen Contract；
- 修改当前 Release Gate；
- 把现有 Core Runtime 能力移出 Community；
- 为 Enterprise 假设提前制造 Adapter 层。

当前最高优先级仍然是：

> **完成 V0.1.0 Release Readiness、Browser Acceptance 和 Release Gate。**

---

## 12. V0.1.0 发布后的正式评审 Gate

V0.1.0 发布后，先做评审，不直接开发 Enterprise。

### Gate A — Community Baseline

回答：

1. V0.1.0 实际形成了哪些完整 Runtime 能力？
2. 哪些能力是 Modelry 的核心差异化？
3. 哪些能力一旦收费墙限制，会破坏应用闭环？
4. Community 是否已经可以真实部署和维护？
5. V0.1.x Completion 中哪些能力应先完成再讨论 Enterprise？

输出：

**Community Edition Baseline**

### Gate B — Enterprise Problem Validation

回答：

1. 当前真实用户遇到了哪些团队治理问题？
2. 是否真的存在 Organization / Team 需求？
3. 是否真的需要 SSO / SCIM？
4. HA / DR / Central Audit 哪些有明确付费价值？
5. Self-hosted Enterprise 和 Hosted Edition 是否是同一个产品问题？

输出：

**Enterprise Problem Statement**

### Gate C — Architecture Boundary

回答：

1. Enterprise 能力是否可以复用现有 Core Domain？
2. 哪些能力需要 Provider / Capability 扩展？
3. One Instance / One Project 是否保持？
4. Enterprise Control Plane 是否独立存在？
5. Single Binary 如何组合？
6. Repository 如何划分？
7. Upgrade / Compatibility 如何保证？

输出：

**Edition Architecture ADR**

### Gate D — Commercial Boundary

回答：

1. 最终哪些能力属于 Community？
2. 哪些属于 Enterprise？
3. License 采用什么模型？
4. Trial 如何提供？
5. Commercial Support 如何提供？
6. 是否规划 Modelry Cloud？

输出：

**Community / Enterprise Edition Specification**

只有以上 Gate 完成后，才创建 Enterprise 实现级 Issues。

---

## 13. V0.1.0 后建议形成的正式文档

编号届时按仓库实际序列确定，不提前占用 `0008`。

建议依次产出：

1. **Community Edition Baseline**
2. **Enterprise Problem Statement**
3. **ADR — Edition Architecture**
4. **ADR — Enterprise Extension / Composition Model**
5. **Community / Enterprise Edition Boundary Spec**
6. **Enterprise Security & Identity Model**
7. **Enterprise Deployment / HA Architecture**
8. **Licensing & Packaging Design**
9. **Enterprise V1 Scope**

---

## 14. 当前暂定结论

V0.1.0 发布前只锁定以下原则。

### 原则一：Community 必须完整

> Modelry Community 应当是一套真实、完整、可自行部署的 Backend Runtime，而不是 Demo Edition。

### 原则二：核心应用能力不作为主要收费墙

> Collection、Record、Relation、Policy、Application Auth、API、MCP、ChangeSet、Migration 等核心 Backend 闭环原则上保持 Community 可用。

### 原则三：Enterprise 解决企业规模问题

> 商业价值优先来自 Organization、Identity、Governance、Security、Audit、Scale、Operations、Enterprise Integration 与 Support。

### 原则四：唯一 Core Runtime

> Community 与 Enterprise 共享同一套核心领域语义和 Runtime，不长期维护两套 Backend Core。

### 原则五：不提前抽象

> V0.1.0 不为了未来 Enterprise 预埋未验证的复杂扩展架构；V0.1.0 发布后基于真实代码与需求再决定抽象边界。

### 原则六：商业化不能破坏当前产品不变量

> One Instance / One Project、Data Plane / Control Plane 分离、Human / Agent 共用 Backend semantics 等不变量，除非后续 Accepted ADR 明确修改，否则继续成立。
