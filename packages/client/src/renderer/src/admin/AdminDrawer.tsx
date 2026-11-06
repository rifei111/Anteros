import { useEffect, useRef, useState } from "react";
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
import { MultiModelTab } from "./tabs/MultiModelTab";
import { OwnerTab } from "./tabs/OwnerTab";
import { PersonaTab } from "./tabs/PersonaTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { ProactiveTab } from "./tabs/ProactiveTab";
import { UpdateTab } from "./tabs/UpdateTab";
import { VoiceTab } from "./tabs/VoiceTab";

interface RailItem {
  id: AdminTab;
  label: string;
}

interface RailGroup {
  title: string;
  items: ReadonlyArray<RailItem>;
}

/**
 * 四组，而不是十四个平铺的页签：
 * 对话（它是谁、怎么说话、什么时候开口、记得什么）/ 它（声音、模型、账）/
 * 连接（外部通道、插件）/ 系统（更新、数据、高级、Owner）。
 */
const GROUPS: ReadonlyArray<RailGroup> = [
  {
    title: "对话",
    items: [
      { id: "persona", label: "人格" },
      { id: "expression", label: "表达与完全体" },
      { id: "proactive", label: "主动消息" },
      { id: "memory", label: "记忆" },
    ],
  },
  {
    title: "它",
    items: [
      { id: "voice", label: "声音" },
      { id: "model", label: "模型" },
      { id: "models", label: "多模型" },
      { id: "cost", label: "成本" },
    ],
  },
  {
    title: "连接",
    items: [
      { id: "channels", label: "通道" },
      { id: "plugins", label: "插件" },
    ],
  },
  {
    title: "系统",
    items: [
      { id: "update", label: "更新" },
      { id: "data", label: "数据" },
      { id: "advanced", label: "高级" },
      { id: "owner", label: "Owner" },
    ],
  },
];

const ALL_ITEMS: ReadonlyArray<RailItem> = GROUPS.flatMap((group) => group.items);

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
    case "voice":
      return <VoiceTab />;
    case "proactive":
      return <ProactiveTab />;
    case "cost":
      return <CostTab />;
    case "model":
      return <ModelTab />;
    case "models":
      return <MultiModelTab />;
    case "advanced":
      return <AdvancedTab />;
    case "update":
      return <UpdateTab />;
    case "data":
      return <DataTab />;
  }
}

type FadeState = "none" | "top" | "bottom" | "both";

/**
 * 设置面：整窗，左边一列分组，右边一页内容。
 *
 * 这里放所有「不该出现在聊天气泡里」的东西：权限、插件、通道、记忆台账、
 * 成本、模型密钥状态、日志、数据导出。危险操作都必须二次确认。
 */
export function AdminDrawer() {
  const state = useAppState();
  const current: RailItem = ALL_ITEMS.find((item) => item.id === state.adminTab) ?? { id: "persona", label: "人格" };
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState<FadeState>("none");

  // 内容比窗口高的时候，上下各留一道渐隐，让「还有 / 前面还有」看得见。
  function syncFade() {
    const panel = panelRef.current;
    if (!panel) {
      setFade("none");
      return;
    }
    const atTop = panel.scrollTop <= 2;
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2;
    if (atTop && atBottom) setFade("none");
    else if (atTop) setFade("bottom");
    else if (atBottom) setFade("top");
    else setFade("both");
  }

  // 换页时回到顶部，并重新算一次渐隐。
  useEffect(() => {
    const panel = panelRef.current;
    if (panel) panel.scrollTop = 0;
    const frame = requestAnimationFrame(syncFade);
    return () => cancelAnimationFrame(frame);
  }, [state.adminTab]);

  return (
    <div className="admin-mask" onMouseDown={(event) => event.target === event.currentTarget && closeAdmin()}>
      <div className="admin-drawer" role="dialog" aria-modal="true" aria-label="管理面板">
        <aside className="admin-rail">
          <div className="rail-title">设置</div>
          {GROUPS.map((group) => (
            <div className="rail-group" key={group.title}>
              <div className="rail-group-title">{group.title}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`rail-item ${state.adminTab === item.id ? "active" : ""}`}
                  onClick={() => setAdminTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="admin-main" data-fade={fade}>
          <header className="admin-head">
            <div>
              <div className="admin-title">{current.label}</div>
              <div className="admin-sub">
                本机专属 · {state.owner?.isOwner ? "owner" : "非 owner"} · 危险操作一律二次确认
              </div>
            </div>
            <button className="icon-btn" onClick={() => closeAdmin()} aria-label="关闭设置">
              <CloseIcon />
            </button>
          </header>

          <div className="admin-panel" ref={panelRef} onScroll={syncFade}>
            {renderTab(state.adminTab)}
          </div>
          <div className="admin-fade admin-fade-top" aria-hidden="true" />
          <div className="admin-fade admin-fade-bottom" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}