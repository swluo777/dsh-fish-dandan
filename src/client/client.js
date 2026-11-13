window.__ModuleLoader__.load({
	id: "dsh-fish-dandan",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect } = react;

		const API_BASE = "fish-dandan/api";

		/* ------------------------------------------------------------------
		 * 基础设施
		 * ------------------------------------------------------------------ */

		function apiUrl(path) {
			const relative = `${API_BASE}${path}`.replace(/^\/+/, "");
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
		}

		async function request(path) {
			let response;
			try {
				response = await fetch(apiUrl(path), { method: "GET", credentials: "same-origin" });
			} catch (_error) {
				throw new Error("连不上宿主，稍后再试");
			}
			let data = null;
			try {
				data = await response.json();
			} catch (_error) {
				data = null;
			}
			if (!response.ok || (data && data.ok === false)) {
				const message = data && data.error && data.error.message ? data.error.message : `请求失败（HTTP ${response.status}）`;
				throw new Error(message);
			}
			return data;
		}

		const STATE_TONE = {
			sleep: "dim",
			rest: "neutral",
			explore: "warn",
			social: "success",
			create: "brand",
		};

		const CSS = `
.fd-panel{--fd-border:var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1, #e6e6e6));--fd-fill:var(--dsw-alias-settings-card-fill, transparent);--fd-text:var(--dsw-alias-label-primary,#1a1a1a);--fd-dim:var(--dsw-alias-label-tertiary,#8a8a8a);border:1px solid var(--fd-border);border-radius:var(--dsw-radius-lg,12px);background:var(--fd-fill);color:var(--fd-text);padding:16px 16px 14px;font-size:13px;}
.fd-top{display:flex;align-items:center;gap:11px;min-width:0;}
.fd-avatar{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-brand-primary,#2b6cff);background:color-mix(in oklab, var(--dsw-alias-brand-primary,#2b6cff) 12%, transparent);}
.fd-grow{flex:1;min-width:0;}
.fd-name{font-weight:600;font-size:14.5px;line-height:1.35;}
.fd-sub{color:var(--fd-dim);font-size:12px;line-height:1.4;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fd-chip{flex:none;font-size:11px;line-height:19px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#f1f1f1);color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;}
.fd-chip.brand{background:color-mix(in oklab, var(--dsw-alias-brand-primary,#2b6cff) 14%, transparent);color:var(--dsw-alias-brand-primary,#2b6cff);}
.fd-chip.success{background:var(--dsw-alias-state-success-tertiary,#e8f6ee);color:var(--dsw-alias-state-success-primary,#1e7b45);}
.fd-chip.warn{background:var(--dsw-alias-state-warn-tertiary,#fff4e5);color:var(--dsw-alias-state-warn-primary,#a35b00);}
.fd-chip.dim{background:var(--dsw-alias-bg-layer-3,#f1f1f1);color:var(--fd-dim);}
.fd-split{height:1px;background:var(--dsw-alias-border-l1,#ececec);margin:13px 0 12px;}
.fd-cta{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#2b6cff);border-radius:8px;padding:7px 13px;text-decoration:none;line-height:1;}
.fd-cta:hover{filter:brightness(.96);}
.fd-cta svg{display:block;}
.fd-hint{color:var(--fd-dim);font-size:11.5px;line-height:1.6;margin-top:9px;}
.fd-off{display:inline-flex;align-items:center;font-size:12px;font-weight:600;color:var(--fd-dim);background:var(--dsw-alias-bg-layer-3,#f1f1f1);border-radius:8px;padding:7px 13px;line-height:1;}
.fd-reboot{margin-top:6px;}
.fd-reboot b{color:var(--dsw-alias-state-warn-primary,#a35b00);font-weight:600;}
.fd-error{margin-top:10px;font-size:12px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary,#fff4e5);color:var(--dsw-alias-state-error-primary,#b3261e);}
`;

		function ensureStyles() {
			if (typeof document === "undefined") return () => {};
			const existing = document.getElementById("fish-dandan-style");
			if (existing) return () => {};
			const el = document.createElement("style");
			el.id = "fish-dandan-style";
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => {
				if (el.parentNode) el.parentNode.removeChild(el);
			};
		}

		/* ------------------------------------------------------------------
		 * 小组件
		 * ------------------------------------------------------------------ */

		/** 设置导航与卡片共用的彩色 Q 版头像：assets/avatar.png 的内联副本，零外部请求。 */
		const AVATAR_DATA = "data:image/png;base64,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";

		function FishIcon(props) {
			const size = props.size || 16;
			return h("img", {
				src: AVATAR_DATA,
				width: size,
				height: size,
				alt: "",
				"aria-hidden": "true",
				style: { display: "block", width: size + "px", height: size + "px",
					objectFit: "contain", opacity: props.active ? 1 : 0.86 },
			});
		}

		function ArrowIcon() {
			return h(
				"svg",
				{ width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M3.2 8.8 8.8 3.2M4.4 3.2h4.4v4.4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }),
			);
		}

		/* ------------------------------------------------------------------
		 * 设置分区内容：只做一件事——把用户送去网页版
		 * 表单、审计、状态变量全部在网页里，避免两套界面各说一套。
		 * ------------------------------------------------------------------ */

		function Card() {
			const [overview, setOverview] = useState(null);
			const [error, setError] = useState("");

			useEffect(() => {
				let alive = true;
				request("/overview")
					.then((data) => {
						if (alive) {
							setOverview(data);
							setError("");
						}
					})
					.catch((err) => {
						if (alive) setError(err.message);
					});
				return () => {
					alive = false;
				};
			}, []);

			const persona = overview && overview.persona;
			const memory = overview && overview.memory;
			const decision = overview && overview.decision;
			const uiUrl = overview && overview.uiUrl;

			const summary = persona
				? [persona.name, memory ? `${memory.total} 条记忆` : null].filter(Boolean).join(" · ")
				: error
					? "运行状态读取失败"
					: "正在读取运行状态…";

			// 首装引导：还没配置过就明说，别让新用户以为「已经配好了」
			const wizard = overview && overview.wizard;
			const fresh = Boolean(wizard && wizard.done === false);
			const setupUrl = uiUrl ? `${uiUrl}#setup` : null;

			return h(
				"div",
				{ className: "fd-panel" },
				h(
					"div",
					{ className: "fd-top" },
					h("span", { className: "fd-avatar" }, h(FishIcon, { size: 23, active: true })),
					h(
						"div",
						{ className: "fd-grow" },
						h("div", { className: "fd-name" }, "我的大肥鱼"),
						h("div", { className: "fd-sub" }, fresh ? "还没起名字，现在它先按默认人设说话" : summary),
					),
					fresh
						? h("span", { className: "fd-chip" }, "还没配置")
						: decision
							? h("span", { className: `fd-chip ${STATE_TONE[decision.state] || ""}` }, decision.label)
							: null,
				),
				h("div", { className: "fd-split" }),
				uiUrl
					? h("a", { className: "fd-cta", href: fresh && setupUrl ? setupUrl : uiUrl, target: "_blank", rel: "noreferrer" }, fresh ? "花一分钟认识它" : "打开设置页", h(ArrowIcon))
					: h("span", { className: "fd-off" }, "设置页不可用"),
				h(
					"div",
					{ className: "fd-hint" },
					uiUrl
						? fresh
							? "不配置也能用：直接开个对话，它第一句会先问你怎么称呼。想改名字、称呼和性子，点上面那个按钮。"
							: "人格、记忆、状态、平台都在网页里配置，保存后下一步对话就生效。"
						: "宿主暂时没有可访问的 web 服务，所以网页版打不开。",
				),
				!uiUrl
					? h(
							"div",
							{ className: "fd-hint fd-reboot" },
							h("b", null, "刚启用或重新启用插件后，需要重启 DSH 才能生效"),
							"；重启前人格、记忆等其余部分照常工作。",
						)
					: null,
				error ? h("div", { className: "fd-error" }, error) : null,
			);
		}

		/* ------------------------------------------------------------------
		 * 插件入口
		 * ------------------------------------------------------------------ */

		const name = "fish-dandan";
		const inject = ["slots"];

		/** 设置导航里的分区 id，图标与分区共用同一个 id 才能配对。 */
		const SECTION_ID = "fish-dandan";

		function apply(ctx) {
			try {
				const disposeStyles = ensureStyles();
				ctx.effect(() => disposeStyles, "fish-dandan:styles");

				// 设置 →「我的大肥鱼」独立分区，和「插件」「插件市场」同级。
				// 这是 dsh-client-ui-settings 声明的稳定插槽，不依赖插件管理器的内部列表。
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: SECTION_ID,
							order: 45,
							label: () => "我的大肥鱼",
						},
						() => h(Card),
					),
				);

				ctx.slots.inject("settings.section.icon", () =>
					ctx.slots.register(
						{ name: "settings.section.icon", id: SECTION_ID },
						(owner = {}) => h(FishIcon, { size: owner.size || 16, active: Boolean(owner.active) }),
					),
				);
			} catch (error) {
				console.error("[fish-dandan] 面板挂载失败，插件其余功能不受影响", error);
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.Card = Card;
		return module.exports;
	},
});
