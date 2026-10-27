import { CloseIcon } from "../components/Icons";
import { closeAdmin, setAdminTab } from "../lib/app";
import { useAppState, type AdminTab } from "../lib/store";
import { AdvancedTab } from "./tabs/AdvancedTab";
import { ChannelsTab } from "./tabs/ChannelsTab";
import { CostTab } from "./tabs/CostTab";
import { DataTab } from "./tabs/DataTab";
import { ExpressionTab } from "./tabs/ExpressionTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { ModelTab } from "./tabs/ModelTab";
import { OwnerTab } from "./tabs/OwnerTab";
import { PersonaTab } from "./tabs/PersonaTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { ProactiveTab } from "./tabs/ProactiveTab";
import { UpdateTab } from "./tabs/UpdateTab";

const TABS: ReadonlyArray<{ id: AdminTab; label: string }> = [
  { id: "owner", label: "Owner" },
  { id: "persona", label: "人格" },
  { id: "plugins", label: "插件" },
  { id: "channels", label: "通道" },
  { id: "memory", label: "记忆" },
  { id: "expression", label: "表达与完全体" },
  { id: "proactive", label: "主动消息" },
  { id: "cost", label: "成本" },
  { id: "model", label: "模型" },
  { id: "advanced", label: "高级" },
  { id: "update", label: "更新" },
  { id: "data", label: "数据" },
];

function renderTab(tab: AdminTab) {
  switch (tab) {
    case "owner":
      return <OwnerTab />;
    case "persona":
      return <PersonaTab />;
    case "plugins":
      return <PluginsTab />;
    case "channels":
      return <ChannelsTab />;
    case "memory":
      return <MemoryTab />;
    case "expression":
      return <ExpressionTab />;
    case "proactive":
      return <ProactiveTab />;
    case "cost":
      return <CostTab />;
    case "model":
      return <ModelTab />;
    case "advanced":
      return <AdvancedTab />;
    case "update":
      return <UpdateTab />;
    case "data":
      return <DataTab />;
  }
}

/**
 * 管理面板：右侧抽屉，标签页切换。
 *
 * 这里放所有「不该出现在聊天气泡里」的东西：权限、插件、通道、记忆台账、
 * 成本、模型密钥状态、日志、数据导出。危险操作都必须二次确认。
 */
export function AdminDrawer() {
  const state = useAppState();

  return (
    <div className="admin-mask" onMouseDown={(event) => event.target === event.currentTarget && closeAdmin()}>
      <aside className="admin-drawer" role="dialog" aria-modal="true" aria-label="管理面板">
        <header className="admin-head">
          <div>
            <div className="admin-title">管理面板</div>
            <div className="admin-sub">
              本机专属 · {state.owner?.isOwner ? "owner" : "非 owner"} · 危险操作一律二次确认
            </div>
          </div>
          <button className="icon-btn" onClick={() => closeAdmin()} aria-label="关闭管理面板">
            <CloseIcon />
          </button>
        </header>

        <nav className="admin-nav" aria-label="管理面板标签">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`admin-tab ${state.adminTab === tab.id ? "active" : ""}`}
              onClick={() => setAdminTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="admin-panel">{renderTab(state.adminTab)}</div>
      </aside>
    </div>
  );
}
