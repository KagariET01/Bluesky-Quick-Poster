// 暫存即將被編輯框認領的 Quote 網址
let pendingQuoteUrl = null;

// 全域監聽：捕獲 Quote 與 Draft 點擊事件，不再暴力阻止原生選單彈出
document.addEventListener(
	'click',
	(e) => {
		// 1. 監聽推文內的轉發按鈕 (預先記下推文網址，若使用者後續選「Quote」時由編輯框認領)
		const retweetBtn = e.target.closest('[data-testid="retweet"], [data-testid="unretweet"]');
		if (retweetBtn) {
			const article = retweetBtn.closest('article');
			if (article) {
				const timeLink = article.querySelector('time')?.closest('a');
				const statusLink = article.querySelector('a[href*="/status/"]');
				const tweetUrl = timeLink?.href || statusLink?.href;
				if (tweetUrl) {
					pendingQuoteUrl = tweetUrl;
				}
			}
			return;
		}

		// 2. 監聽 Twitter 選單中的「Quote / 引用推文」選項
		const quoteMenuItem = e.target.closest('a[href*="/compose/tweet"], [role="menuitem"]');
		if (quoteMenuItem && (quoteMenuItem.innerText.includes('Quote') || quoteMenuItem.innerText.includes('引用'))) {
			console.log('[Crosspost] 使用者進入 Quote 模式，等待編輯框認領:', pendingQuoteUrl);
			return;
		}

		// 3. 監聽 Drafts（草稿）列表中的項目點擊
		const draftItem = e.target.closest('div[role="button"][tabindex="0"], div[data-testid="cellInnerDiv"]');
		if (draftItem) {
			const text = draftItem.innerText || '';
			const match = text.match(/https?:\/\/(?:x|twitter)\.com\/[^\/\s]+\/status\/\d+/);
			if (match) {
				pendingQuoteUrl = match[0];
			}
		}
	},
	true
);

// 全域狀態鎖與發送旗標
let isPostingLocked = false;
let isBypassingOriginalClick = false;

// 預設發送平台勾選狀態 (預設兩者皆開啟)
let targetPlatforms = {
	x: true,
	bsky: true,
};

function init() {
	chrome.storage.local.get(['handle', 'appPassword'], (res) => {
		if (res.handle && res.appPassword) {
			observeTwitterDOM();
		}
	});
}

function observeTwitterDOM() {
	let isChecking = false;

	const checkAndInject = () => {
		if (isChecking) return;
		isChecking = true;

		try {
			setupCustomBottomBar();
			bindShortcutKeys();
			validatePostReadiness();
			observeTwitterDropdownMenu(); // 即時偵測並擴充轉發選單
		} finally {
			isChecking = false;
		}
	};

	const observer = new MutationObserver((mutations) => {
		const isSelfMutation = mutations.every(
			(m) =>
				m.target.id === 'crosspost-green-btn' ||
				m.target.id === 'crosspost-toolbar-row' ||
				m.target.closest?.('#crosspost-toolbar-row')
		);
		if (!isSelfMutation) {
			checkAndInject();
		}
	});

	observer.observe(document.body, { childList: true, subtree: true });
	checkAndInject();
}

/*
// 1. 注入左側側邊欄的綠色星星按鈕
function injectGreenButton() {
	if (document.getElementById('crosspost-green-btn')) return;

	const tweetBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
	if (tweetBtn) {
		const container = tweetBtn.parentElement;
		const greenBtn = document.createElement('div');
		greenBtn.id = 'crosspost-green-btn';
		greenBtn.title = '開啟多平台發文面板';
		greenBtn.style.cssText = `
			margin-top: 12px;
			width: 50px;
			height: 50px;
			background: linear-gradient(135deg, #00ba7c 0%, #0085ff 100%);
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			box-shadow: 0 4px 12px rgba(0, 186, 124, 0.4);
			transition: transform 0.15s ease;
		`;
		greenBtn.innerHTML = `
			<svg width="24" height="24" viewBox="0 0 24 24" fill="white">
				<path d="M12 2L15 8L21 9L17 14L18 20L12 17L6 20L7 14L3 9L9 8L12 2Z"/>
			</svg>
		`;

		greenBtn.onmouseenter = () => (greenBtn.style.transform = 'scale(1.08)');
		greenBtn.onmouseleave = () => (greenBtn.style.transform = 'scale(1)');

		greenBtn.onclick = (e) => {
			e.stopPropagation();
			tweetBtn.click();
		};

		container.appendChild(greenBtn);
	}
}
*/

// 2. 嚴格限定：只在「建立貼文/Quote 彈窗」或「首頁頂部(/home)主發文區」生效
function setupCustomBottomBar() {
	const modal = document.querySelector('[aria-labelledby="modal-header"][role="dialog"]');

	let targetRoot = null;
	let nativeSubmitBtn = null;

	if (modal) {
		// 檢查彈窗是否包含 Quote 卡片或剛才捕獲的 pendingQuoteUrl
		const hasQuoteCard =
			modal.querySelector('[data-testid="quoteTweet"], div[role="link"][tabindex="0"]') !== null ||
			Boolean(pendingQuoteUrl);

		// 取得輸入框本體的標籤與 Placeholder
		const textarea = modal.querySelector('[data-testid^="tweetTextarea_"]');
		const placeholder = textarea?.getAttribute('aria-label') || '';
		const labelText = modal.querySelector('[data-testid="tweetTextarea_0_label"]')?.innerText || '';

		// 只有在「確定不是 Quote」且「文字框標籤明確是 Reply」的情境下，才判定為回覆彈窗
		const isExplicitReply =
			(placeholder.toLowerCase().includes('reply') || labelText.toLowerCase().includes('reply')) &&
			!hasQuoteCard;

		// 若彈窗上方有貼文串相連線（tweet-thread connector），且沒有 Quote 卡片，才是真正的推文回覆
		const hasThreadLine = modal.querySelector('[data-testid="cellInnerDiv"] [dir="auto"]') && !hasQuoteCard;

		if (isExplicitReply && hasThreadLine) {
			return;
		}

		targetRoot = modal;
		nativeSubmitBtn = modal.querySelector('[data-testid="tweetButton"]');
	} else {
		// 非彈窗模式：僅在首頁 (/home 或根目錄) 生效
		const path = window.location.pathname;
		const isHomePage = path === '/home' || path === '/';
		if (!isHomePage) return;

		const inlineButtons = Array.from(
			document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')
		);
		for (const btn of inlineButtons) {
			const replyContainer = btn.closest('article, [data-testid="cellInnerDiv"]');
			const isReplyBox =
				replyContainer &&
				(replyContainer.innerText.includes('Replying to') ||
					replyContainer.innerText.includes('回覆給') ||
					replyContainer.innerText.includes('Post your reply') ||
					replyContainer.innerText.includes('發布你的回覆'));

			if (!isReplyBox) {
				const textarea = btn.closest('div[class*="css-175oi2r"]')?.querySelector('[data-testid^="tweetTextarea_"]');
				const placeholder = textarea?.getAttribute('aria-label') || '';
				if (!placeholder.toLowerCase().includes('reply')) {
					targetRoot = btn.closest('[data-testid^="tweetTextarea_"]')?.parentElement || btn.parentElement;
					nativeSubmitBtn = btn;
					break;
				}
			}
		}
	}

	if (!nativeSubmitBtn) return;

	// 隱藏 Twitter 原生按鈕（保留在 DOM 供程式觸發）
	nativeSubmitBtn.style.setProperty('display', 'none', 'important');

	const buttonHost = nativeSubmitBtn.parentElement.parentElement.parentElement.parentElement;
	if (!buttonHost) return;

	buttonHost.style.margin = '0';

	// 尋找是否已有工具列
	let existingRow = buttonHost.querySelector('#crosspost-toolbar-row');
	if (existingRow) {
		// 若已有工具列，檢查是否有待認領的 Quote 網址
		if (pendingQuoteUrl && !existingRow.dataset.quoteUrl) {
			existingRow.dataset.quoteUrl = pendingQuoteUrl;
			console.log('[Crosspost] 工具列成功認領 Quote 網址:', pendingQuoteUrl);
			pendingQuoteUrl = null;
		}
		updatePlatformButtonsStyle();
		return;
	}

	// 建立全新的一橫列容器
	const newRow = document.createElement('div');
	newRow.id = 'crosspost-toolbar-row';
	newRow.style.cssText = `
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 0px;
		border: none;
		font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		box-sizing: border-box;
		width: 100%;
	`;

	// 若當前有 pendingQuoteUrl，立即注入 dataset
	if (pendingQuoteUrl) {
		newRow.dataset.quoteUrl = pendingQuoteUrl;
		console.log('[Crosspost] 新工具列建立並成功認領 Quote 網址:', pendingQuoteUrl);
		pendingQuoteUrl = null;
	}

	// 左側平台開關區 (X, Bsky)
	const leftGroup = document.createElement('div');
	leftGroup.style.cssText = `display: flex; align-items: center; gap: 8px;`;

	const xToggleBtn = createToggleBtn('x', 'X (Twitter)', targetPlatforms.x);
	const bskyToggleBtn = createToggleBtn('bsky', 'Bluesky', targetPlatforms.bsky);

	leftGroup.appendChild(xToggleBtn);
	leftGroup.appendChild(bskyToggleBtn);

	// 右側獨立發文按鈕
	const customSubmitBtn = document.createElement('button');
	customSubmitBtn.id = 'crosspost-custom-submit-btn';
	customSubmitBtn.type = 'button';
	customSubmitBtn.style.cssText = `
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 0px 20px;
		background-color: rgb(239, 243, 244);
		color: rgb(15, 20, 25);
		border: none;
		border-radius: 9999px;
		font-family: inherit;
		font-size: 15px;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s ease;
	`;
	customSubmitBtn.innerHTML = `<span>Post</span>`;

	customSubmitBtn.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();

		if (!canSendPosts(targetPlatforms)) {
			return;
		}

		executePlatformPosting(targetPlatforms);
	};

	newRow.appendChild(leftGroup);
	newRow.appendChild(customSubmitBtn);

	buttonHost.appendChild(newRow);
	updatePlatformButtonsStyle();
}

// 輔助：建立切換平台狀態的標籤按鈕
function createToggleBtn(platformKey, label, initialActive) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.dataset.platform = platformKey;
	btn.style.cssText = `
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: 9999px;
		font-family: inherit;
		font-size: 13px;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.2s ease;
		user-select: none;
	`;
	btn.innerHTML = `<span>${label}</span>`;

	btn.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		targetPlatforms[platformKey] = !targetPlatforms[platformKey];
		updatePlatformButtonsStyle();
		validatePostReadiness();
	};

	return btn;
}

// 更新平台開關樣式與發文按鈕狀態
function updatePlatformButtonsStyle() {
	const row = document.getElementById('crosspost-toolbar-row');
	if (!row) return;

	const buttons = row.querySelectorAll('button[data-platform]');
	buttons.forEach((btn) => {
		const key = btn.dataset.platform;
		const isActive = targetPlatforms[key];

		if (isActive) {
			if (key === 'x') {
				btn.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
				btn.style.border = '1px solid rgba(255, 255, 255, 0.4)';
				btn.style.color = '#ffffff';
			} else if (key === 'bsky') {
				btn.style.backgroundColor = 'rgba(15, 115, 255, 0.2)';
				btn.style.border = '1px solid rgb(15, 115, 255)';
				btn.style.color = 'rgb(68, 150, 255)';
			}
		} else {
			btn.style.backgroundColor = 'transparent';
			btn.style.border = '1px solid rgba(255, 255, 255, 0.15)';
			btn.style.color = '#71767b';
		}
	});

	const postBtnSpan = row.querySelector('#crosspost-custom-submit-btn span');
	if (postBtnSpan && !isPostingLocked) {
		const enabled = [];
		if (targetPlatforms.x) enabled.push('X');
		if (targetPlatforms.bsky) enabled.push('Bsky');
		postBtnSpan.innerText = enabled.length > 0 ? `Post (${enabled.join('+')})` : 'Post';
	}
}

// 核心檢查：檢查「是否能發送」（必須至少有一個平台勾選，且必須有打字或有圖片）
function canSendPosts(config) {
	// 1. 是否選擇了平台
	if (!config.x && !config.bsky) {
		return false;
	}

	// 2. 是否有有效內容（文字或圖片）
	const modal = document.querySelector('[aria-labelledby="modal-header"][role="dialog"]');
	const searchRoot = modal || document;

	const visibleTextareas = Array.from(searchRoot.querySelectorAll('[data-testid^="tweetTextarea_"]')).filter((ta) => {
		const rect = ta.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && window.getComputedStyle(ta).display !== 'none';
	});

	const placeholders = [
		'What is happening?!',
		"What's happening?",
		'有什麼新鮮事？',
		'發布你的回覆',
		'Post your reply',
		'新增另一則推文',
		'Add another post',
	];

	let hasText = false;
	for (const ta of visibleTextareas) {
		const txt = ta.innerText ? ta.innerText.trim() : '';
		if (txt.length > 0 && !placeholders.includes(txt)) {
			hasText = true;
			break;
		}
	}

	// 檢查是否有上傳圖片 (blob 圖片)
	const hasImages = searchRoot.querySelectorAll('img[src^="blob:"]').length > 0;

	return hasText || hasImages;
}

// 動態更新 Post 按鈕的啟用 / 禁用外觀
function validatePostReadiness() {
	const customSubmitBtn = document.getElementById('crosspost-custom-submit-btn');
	if (!customSubmitBtn || isPostingLocked) return;

	const ready = canSendPosts(targetPlatforms);

	if (ready) {
		customSubmitBtn.style.opacity = '1';
		customSubmitBtn.style.cursor = 'pointer';
	} else {
		customSubmitBtn.style.opacity = '0.5';
		customSubmitBtn.style.cursor = 'not-allowed';
	}
}

// 3. 綁定快捷鍵 (Ctrl+Enter / Cmd+Enter)
function bindShortcutKeys() {
	const textareas = document.querySelectorAll('[data-testid^="tweetTextarea_"]');
	textareas.forEach((textarea) => {
		if (textarea.dataset.shortcutBound) return;
		textarea.dataset.shortcutBound = 'true';

		// 監聽文字輸入更新按鈕啟用狀態
		textarea.addEventListener('input', validatePostReadiness);

		textarea.addEventListener(
			'keydown',
			(e) => {
				if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
					// 向上尋找此輸入框對應的發文區容器內是否有「複合式發文工具列」
					const hostContainer =
						textarea.closest('[aria-labelledby="modal-header"][role="dialog"]') ||
						textarea.closest('div[class*="css-175oi2r"]');

					const crosspostRow = hostContainer?.querySelector('#crosspost-toolbar-row') ||
						document.querySelector('#crosspost-toolbar-row');

					// 若不在複合式發文區內（例如看圖或推文底部的回覆框），完全不攔截，保持原生 Twitter 邏輯
					if (!crosspostRow) {
						return;
					}

					// 核心檢查：若文字為空且沒圖片，直接 return
					if (!canSendPosts({ x: true, bsky: true })) {
						return;
					}

					// 確定在複合發文區：攔截原生事件，改由自訂按鈕處理
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();

					// 需求：Ctrl+Enter 強制打開所有社群開關 (X + Bsky)
					targetPlatforms.x = true;
					targetPlatforms.bsky = true;
					updatePlatformButtonsStyle();
					validatePostReadiness();

					// 接入右側自訂 Post 按鈕：模擬點擊以呈現完整的背景發布狀態變化
					const customSubmitBtn = crosspostRow.querySelector('#crosspost-custom-submit-btn');
					if (customSubmitBtn) {
						customSubmitBtn.click();
					}
				}
			},
			true
		);
	});
}

// 4. 核心發送路由調度器（適配彈窗與首頁頂部發文區）
async function executePlatformPosting(config) {
	if (isPostingLocked) return;
	isPostingLocked = true;

	const customBtn = document.getElementById('crosspost-custom-submit-btn');
	const customBtnSpan = customBtn ? customBtn.querySelector('span') : null;
	const originalText = customBtnSpan ? customBtnSpan.innerText : 'Post';

	const modal = document.querySelector('[aria-labelledby="modal-header"][role="dialog"]');
	// 決定當前上下文的 searchRoot 與原生發文按鈕
	const searchRoot = modal || document.querySelector('#crosspost-toolbar-row')?.closest('div[class*="css-175oi2r"]') || document;
	const nativeSubmitBtn = modal
		? modal.querySelector('[data-testid="tweetButton"]')
		: document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');

	if (customBtn) {
		customBtn.style.pointerEvents = 'none';
		customBtn.style.opacity = '0.7';
	}

	try {
		// 1. Bluesky 發送流程
		if (config.bsky) {
			if (customBtnSpan) customBtnSpan.innerText = '讀取推文...';
			const postsData = await extractTweetsFromModal();

			if (postsData.length === 0) {
				resetPostingState(customBtn, customBtnSpan, originalText);
				return;
			}

			if (customBtnSpan) customBtnSpan.innerText = `發至 Bluesky (${postsData.length})...`;
			await postThreadToBluesky(postsData);
		}

		// 2. Twitter (X) 發送流程
		if (config.x) {
			if (customBtnSpan) customBtnSpan.innerText = '發至 X...';
			if (nativeSubmitBtn) {
				isBypassingOriginalClick = true;
				nativeSubmitBtn.click();
				isBypassingOriginalClick = false;
			}
		} else {
			// 若只發 Bluesky：Modal 點擊關閉，首頁 Top 則清空輸入內容
			if (modal) {
				const closeBtn =
					modal.querySelector('[aria-label="Close"]') ||
					modal.querySelector('[data-testid="app-bar-close"]');
				if (closeBtn) closeBtn.click();
			} else {
				const textarea = document.querySelector('[data-testid^="tweetTextarea_"]');
				if (textarea) {
					textarea.focus();
					document.execCommand('selectAll', false, null);
					document.execCommand('delete', false, null);
				}
			}
		}

		if (customBtnSpan) customBtnSpan.innerText = '完成！';
		setTimeout(() => {
			resetPostingState(customBtn, customBtnSpan, originalText);
		}, 1000);
	} catch (err) {
		console.error(err);
		alert(`發文發生錯誤：${err.message}`);
		resetPostingState(customBtn, customBtnSpan, originalText);
	}
}

function resetPostingState(btn, span, originalText) {
	isPostingLocked = false;
	pendingQuoteUrl = null;

	const toolbarRow = document.getElementById('crosspost-toolbar-row');
	if (toolbarRow) {
		delete toolbarRow.dataset.quoteUrl;
	}

	if (span) span.innerText = originalText;
	if (btn) btn.style.pointerEvents = 'auto';
	updatePlatformButtonsStyle();
	validatePostReadiness();
}

// 5. DOM 貼文與多媒體擷取（支援在串文末端追加獨立 Quote 貼文）
async function extractTweetsFromModal() {
	const modal = document.querySelector('[aria-labelledby="modal-header"][role="dialog"]');
	const searchRoot = modal || document;

	const allTextareas = Array.from(searchRoot.querySelectorAll('[data-testid^="tweetTextarea_"]'));
	const visibleTextareas = allTextareas.filter((ta) => {
		const rect = ta.getBoundingClientRect();
		const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(ta).display !== 'none';
		return isVisible && ta.getAttribute('role') === 'textbox';
	});

	const results = [];

	for (let i = 0; i < visibleTextareas.length; i++) {
		const textarea = visibleTextareas[i];
		let rawText = textarea.innerText ? textarea.innerText.trim() : '';

		const placeholders = [
			'What is happening?!',
			"What's happening?",
			'有什麼新鮮事？',
			'發布你的回覆',
			'Post your reply',
			'新增另一則推文',
			'Add another post',
		];
		if (placeholders.includes(rawText)) {
			rawText = '';
		}

		let bskyText = rawText.replace(/@[a-zA-Z0-9_]+/g, '@?');

		let block = textarea;
		const nextTextarea = visibleTextareas[i + 1];

		while (block.parentElement && block.parentElement !== searchRoot) {
			if (nextTextarea && block.parentElement.contains(nextTextarea)) {
				break;
			}
			block = block.parentElement;
		}

		const imgElements = block ? Array.from(block.querySelectorAll('img[src^="blob:"]')) : [];
		const uniqueSrcs = [...new Set(imgElements.map((img) => img.src))];
		const imageBlobs = [];

		for (const src of uniqueSrcs.slice(0, 4)) {
			try {
				const response = await fetch(src);
				const blob = await response.blob();
				imageBlobs.push(blob);
			} catch (e) {
				console.warn('圖片讀取失敗:', e);
			}
		}

		if (bskyText.length > 0 || imageBlobs.length > 0) {
			results.push({
				text: bskyText,
				images: imageBlobs,
			});
		}
	}

	// 檢查發文區內是否存在被引用的推文 (Quote)
	const quotedUrl = getQuotedTweetUrl(searchRoot);
	if (quotedUrl) {
		// 在串文最後追加一則獨立的 Quote 貼文
		results.push({
			text: `Quote: ${quotedUrl}`,
			images: [],
			quotedUrl: quotedUrl,
		});
	}

	return results;
}

function attachQuoteUrlToActiveToolbar(quoteUrl) {
	const row = document.getElementById('crosspost-toolbar-row');
	if (row) {
		row.dataset.quoteUrl = quoteUrl;
		console.log('[Crosspost] 狀態已寫入至當前複合工具列 DOM:', quoteUrl);
	}
}

// 輔助函式：尋找被引用的推文網址
function getQuotedTweetUrl(searchRoot) {
	console.log('[Crosspost] 檢查目前發文列是否綁定 Quote 狀態...');

	// 1. 優先從複合工具列身上的 dataset 讀取
	const toolbarRow = searchRoot.querySelector('#crosspost-toolbar-row') || document.getElementById('crosspost-toolbar-row');
	if (toolbarRow && toolbarRow.dataset.quoteUrl) {
		console.log('[Crosspost] 成功自工具列 DOM dataset 提取 Quote 網址:', toolbarRow.dataset.quoteUrl);
		return toolbarRow.dataset.quoteUrl;
	}

	// 2. 兜底掃描：直接在當前彈窗或發文框內部的純文字/連結尋找 status 網址（適用 Draft 復原情境）
	const activeDialog = document.querySelector('[role="dialog"]') || searchRoot || document;
	const match = (activeDialog.innerText || '').match(/https?:\/\/(?:x|twitter)\.com\/[^\/\s]+\/status\/\d+/);
	if (match) {
		console.log('[Crosspost] 從彈窗文本掃描命中 Quote 網址:', match[0]);
		return match[0];
	}

	console.warn('[Crosspost] 未在當前發文框內偵測到任何 Quote 狀態');
	return null;
}

// 6. 登入取得 Bluesky Session
// 取得 Bluesky Session（動態取得 PDS 網址）
async function getBskySession() {
	if (!chrome.runtime?.id) {
		throw new Error('擴充功能已重新載入，請按 F5 重新整理頁面！');
	}

	const { handle, appPassword } = await chrome.storage.local.get(['handle', 'appPassword']);
	if (!handle || !appPassword) throw new Error('擴充功能中尚未設定 Bluesky Handle 或 App Password');

	// 動態獲取該使用者的 PDS 網址
	const pdsUrl = await resolvePdsUrl(handle);

	const res = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier: handle, password: appPassword }),
	});

	if (!res.ok) throw new Error('Bluesky 登入驗證失敗');
	const session = await res.json();
	
	return { ...session, pdsUrl };
}

// 7. 上傳圖片 Blob 到自架 PDS
// 上傳圖片 Blob 到該使用者的動態 PDS
async function uploadBlobToPDS(pdsUrl, jwt, blob) {
	const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwt}`,
			'Content-Type': blob.type || 'image/jpeg',
		},
		body: blob,
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`上傳圖片到 PDS 失敗: ${errText}`);
	}

	const data = await res.json();
	return data.blob;
}

// 8. 依序發布串文至 Bluesky
async function postThreadToBluesky(postsData) {
	const session = await getBskySession();
	const jwt = session.accessJwt;
	const did = session.did;
	const pdsUrl = session.pdsUrl;

	let rootRef = null;
	let parentRef = null;

	for (let i = 0; i < postsData.length; i++) {
		const postItem = postsData[i];
		let embed = undefined;

		// 1. 若該篇是使用者主動發送的相簿多圖貼文
		if (postItem.images && postItem.images.length > 0) {
			const uploadedImages = [];
			for (const imgBlob of postItem.images) {
				const pdsBlobRef = await uploadBlobToPDS(pdsUrl, jwt, imgBlob);
				uploadedImages.push({
					alt: '',
					image: pdsBlobRef,
				});
			}

			embed = {
				$type: 'app.bsky.embed.images',
				images: uploadedImages,
			};
		} 
		// 2. 若為 Quote / Repost 的外部連結卡片
		else if (postItem.quotedUrl) {
			let thumbRef = undefined;

			// 若有劫持到原推文的第一張圖片，上傳至 PDS 產生 thumb blob
			if (postItem.thumbBlob) {
				try {
					thumbRef = await uploadBlobToPDS(pdsUrl, jwt, postItem.thumbBlob);
				} catch (e) {
					console.warn('[Crosspost] 上傳縮圖至 PDS 失敗，退回無縮圖模式:', e);
				}
			}

			const externalObj = {
				uri: postItem.quotedUrl,
				title: postItem.title || 'Post on X',
				description: postItem.description || '',
			};

			if (thumbRef) {
				externalObj.thumb = thumbRef; // 標準 ATProto blob 結構
			}

			embed = {
				$type: 'app.bsky.embed.external',
				external: externalObj,
			};
		}

		// 處理內文超連結與 Facets
		const { text: processedText, facets } = replaceUrlsWithLinkFacets(postItem.text, 'link');

		const record = {
			$type: 'app.bsky.feed.post',
			text: processedText,
			createdAt: new Date().toISOString(),
			langs: ['zh-TW', 'en'],
		};

		if (embed) {
			record.embed = embed;
		}

		if (facets) {
			record.facets = facets;
		}

		// 串文關聯判斷
		if (rootRef && parentRef) {
			record.reply = {
				root: { uri: rootRef.uri, cid: rootRef.cid },
				parent: { uri: parentRef.uri, cid: parentRef.cid },
			};
		}

		const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify({
				repo: did,
				collection: 'app.bsky.feed.post',
				record: record,
			}),
		});

		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '無法建立貼文紀錄');
		}

		const createdRecord = await res.json();

		if (!rootRef) {
			rootRef = { uri: createdRecord.uri, cid: createdRecord.cid };
		}
		parentRef = { uri: createdRecord.uri, cid: createdRecord.cid };
	}
}

// 根據 handle 自動解析該帳號所屬的權威 PDS 伺服器網址
async function resolvePdsUrl(handle) {
	// 檢查快取，避免每次發文重複發出解析請求
	const cacheKey = `pds_url_${handle}`;
	const cached = await chrome.storage.local.get([cacheKey]);
	if (cached[cacheKey]) {
		return cached[cacheKey];
	}

	// 1. 透過官方公開端點將 Handle 解析為 DID
	const resHandle = await fetch(
		`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
	);
	if (!resHandle.ok) {
		throw new Error(`無法解析 Handle (@${handle}) 的身分 DID`);
	}
	const { did } = await resHandle.json();

	// 2. 依據 DID 類型取得 DID Document，尋找 #atproto_pds 服務宣告
	let pdsUrl = '';
	if (did.startsWith('did:plc:')) {
		const resDoc = await fetch(`https://plc.directory/${did}`);
		if (!resDoc.ok) throw new Error('無法從 PLC Directory 查詢帳號資料');
		const doc = await resDoc.json();
		const pdsService = doc.service?.find((s) => s.id === '#atproto_pds');
		pdsUrl = pdsService?.serviceEndpoint;
	} else if (did.startsWith('did:web:')) {
		const domain = did.replace('did:web:', '');
		const resDoc = await fetch(`https://${domain}/.well-known/did.json`);
		if (!resDoc.ok) throw new Error('無法從 did:web 查詢帳號資料');
		const doc = await resDoc.json();
		const pdsService = doc.service?.find((s) => s.id === '#atproto_pds');
		pdsUrl = pdsService?.serviceEndpoint;
	}

	if (!pdsUrl) {
		throw new Error('找不到該帳號綁定的 PDS 服務端點');
	}

	// 移除尾隨斜線並快取
	pdsUrl = pdsUrl.replace(/\/+$/, '');
	await chrome.storage.local.set({ [cacheKey]: pdsUrl });
	return pdsUrl;
}

// 建立仿 Twitter 原生外觀的「複合轉推 (Repost)」浮動彈窗
function openCrosspostRepostModal(tweetUrl, tweetArticle) {
	// 若畫面上已有彈窗先移除
	const oldModal = document.getElementById('crosspost-repost-modal');
	if (oldModal) oldModal.remove();

	// 取得原推文作者與預覽摘要
	const authorName = tweetArticle.querySelector('[data-testid="User-Name"]')?.innerText?.split('\n')[0] || 'Post';
	const tweetText = tweetArticle.querySelector('[data-testid="tweetText"]')?.innerText?.slice(0, 100) || '';

	// 彈窗背景遮罩
	const overlay = document.createElement('div');
	overlay.id = 'crosspost-repost-modal';
	overlay.style.cssText = `
		position: fixed;
		top: 0; left: 0; width: 100vw; height: 100vh;
		background-color: rgba(91, 112, 131, 0.4);
		display: flex; align-items: center; justify-content: center;
		z-index: 999999;
		font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	`;

	// 彈窗主體
	const modalBox = document.createElement('div');
	modalBox.style.cssText = `
		background-color: rgb(0, 0, 0);
		border: 1px solid rgb(47, 51, 54);
		border-radius: 16px;
		width: 420px;
		max-width: 90vw;
		padding: 20px;
		box-sizing: border-box;
		box-shadow: 0 8px 24px rgba(255, 255, 255, 0.1);
	`;

	// 標題與關閉按鈕
	modalBox.innerHTML = `
		<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
			<h3 style="margin: 0; color: #fff; font-size: 18px; font-weight: 700;">Repost to Platforms</h3>
			<div id="crosspost-modal-close" style="color: #71767b; font-size: 20px; cursor: pointer; padding: 4px;">✕</div>
		</div>
		<div style="background: rgb(22, 24, 28); border: 1px solid rgb(47, 51, 54); border-radius: 8px; padding: 10px 12px; margin-bottom: 16px;">
			<div style="color: #1d9bf0; font-weight: 700; font-size: 13px; margin-bottom: 4px;">${authorName}</div>
			<div style="color: #e7e9ea; font-size: 14px; line-height: 18px; word-break: break-word;">${tweetText || tweetUrl}</div>
		</div>
	`;

	// 平台開關與發送列 (重用既有 layout)
	const actionRow = document.createElement('div');
	actionRow.style.cssText = `
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 16px;
	`;

	// 平台選擇狀態 (預設遵循 targetPlatforms)
	const localPlatforms = { ...targetPlatforms };

	const leftGroup = document.createElement('div');
	leftGroup.style.cssText = `display: flex; gap: 8px;`;

	const xBtn = createToggleBtn('x', 'X (Twitter)', localPlatforms.x);
	const bskyBtn = createToggleBtn('bsky', 'Bluesky', localPlatforms.bsky);

	// 覆寫點擊邏輯以同步 localPlatforms
	xBtn.onclick = (e) => {
		e.stopPropagation();
		localPlatforms.x = !localPlatforms.x;
		syncToggleStyles();
	};
	bskyBtn.onclick = (e) => {
		e.stopPropagation();
		localPlatforms.bsky = !localPlatforms.bsky;
		syncToggleStyles();
	};

	function syncToggleStyles() {
		[xBtn, bskyBtn].forEach((btn) => {
			const key = btn.dataset.platform;
			const active = localPlatforms[key];
			if (active) {
				btn.style.backgroundColor = key === 'x' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(15, 115, 255, 0.2)';
				btn.style.border = key === 'x' ? '1px solid rgba(255, 255, 255, 0.4)' : '1px solid rgb(15, 115, 255)';
				btn.style.color = key === 'x' ? '#ffffff' : 'rgb(68, 150, 255)';
			} else {
				btn.style.backgroundColor = 'transparent';
				btn.style.border = '1px solid rgba(255, 255, 255, 0.15)';
				btn.style.color = '#71767b';
			}
		});

		const activeList = [];
		if (localPlatforms.x) activeList.push('X');
		if (localPlatforms.bsky) activeList.push('Bsky');
		submitBtn.querySelector('span').innerText = activeList.length > 0 ? `Repost (${activeList.join('+')})` : 'Repost';
		
		// 若全沒選則禁用
		const hasActive = localPlatforms.x || localPlatforms.bsky;
		submitBtn.style.opacity = hasActive ? '1' : '0.5';
		submitBtn.style.pointerEvents = hasActive ? 'auto' : 'none';
	}

	leftGroup.appendChild(xBtn);
	leftGroup.appendChild(bskyBtn);

	// 右側 Repost 按鈕
	const submitBtn = document.createElement('button');
	submitBtn.type = 'button';
	submitBtn.style.cssText = `
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 0 20px;
		background-color: rgb(239, 243, 244);
		color: rgb(15, 20, 25);
		border: none;
		border-radius: 9999px;
		font-family: inherit;
		font-size: 14px;
		font-weight: 700;
		cursor: pointer;
	`;
	submitBtn.innerHTML = `<span>Repost (X+Bsky)</span>`;

	// 點擊觸發轉發作業
	submitBtn.onclick = async (e) => {
		e.stopPropagation();
		if (!localPlatforms.x && !localPlatforms.bsky) return;

		submitBtn.style.pointerEvents = 'none';
		const span = submitBtn.querySelector('span');

		try {
			// 1. Bluesky 發送流程
			if (localPlatforms.bsky) {
				span.innerText = '讀取推文內容與縮圖...';

				// 核心：從 article DOM 完整劫持 title, description 與縮圖 Blob
				const details = await extractTweetDetailsFromArticle(tweetArticle);

				span.innerText = '發至 Bluesky...';
				await postThreadToBluesky([
					{
						text: `Repost: ${tweetUrl}`,
						images: [],
						quotedUrl: tweetUrl,
						title: details.title,
						description: details.description,
						thumbBlob: details.thumbBlob, // 傳入縮圖
					},
				]);
			}

			// 2. Twitter 原生轉發流程
			if (localPlatforms.x) {
				span.innerText = '觸發 Twitter 原生轉發...';
				await triggerNativeTwitterRepost(tweetArticle);
			}

			span.innerText = '轉發完成！';
			setTimeout(() => overlay.remove(), 800);
		} catch (err) {
			console.error(err);
			alert(`轉發失敗: ${err.message}`);
			span.innerText = 'Repost';
			submitBtn.style.pointerEvents = 'auto';
		}
	};

	actionRow.appendChild(leftGroup);
	actionRow.appendChild(submitBtn);
	modalBox.appendChild(actionRow);
	overlay.appendChild(modalBox);

	// 點擊背景遮罩或 X 關閉
	overlay.onclick = (e) => {
		if (e.target === overlay || e.target.id === 'crosspost-modal-close') {
			overlay.remove();
		}
	};

	document.body.appendChild(overlay);
	syncToggleStyles();
}

// 輔助：模擬點擊 Twitter 原生轉推，具備「未呼叫補點重試」與「遇 Undo Repost 維持原樣」機制
async function triggerNativeTwitterRepost(tweetArticle) {
	const nativeRetweetBtn = tweetArticle.querySelector(
		'[data-testid="retweet"], [data-testid="unretweet"]'
	);
	if (!nativeRetweetBtn) return;

	// 1. 確保選單順利被喚出（若未出現則自動補按）
	let dropdown = document.querySelector('[data-testid="Dropdown"]');

	if (!dropdown) {
		isBypassingOriginalClick = true;
		nativeRetweetBtn.click();
		isBypassingOriginalClick = false;

		// 輪詢等待最多 600ms，每 100ms 檢查一次
		for (let i = 0; i < 6; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			dropdown = document.querySelector('[data-testid="Dropdown"]');
			if (dropdown) break;
		}

		// 需求 1：若仍未叫出選單，再補點一次
		if (!dropdown) {
			isBypassingOriginalClick = true;
			nativeRetweetBtn.click();
			isBypassingOriginalClick = false;

			for (let i = 0; i < 4; i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				dropdown = document.querySelector('[data-testid="Dropdown"]');
				if (dropdown) break;
			}
		}
	}

	if (!dropdown) {
		console.warn('[Crosspost] 無法喚出 Twitter 原生轉推選單');
		return;
	}

	// 2. 檢視選單項目
	const menuItems = Array.from(dropdown.querySelectorAll('[role="menuitem"]'));

	// 需求 2：若出現 Undo Repost / 取消轉推，不點擊，直接關閉選單維持原樣
	const isAlreadyReposted = menuItems.some((item) => {
		const text = item.innerText || '';
		return (
			text.includes('Undo') ||
			text.includes('取消轉推') ||
			text.includes('取消轉發') ||
			text.includes('Undo Repost')
		);
	});

	if (isAlreadyReposted) {
		console.log('[Crosspost] 此推文已在 X 轉發過，維持原樣不點擊 Undo');
		document.body.click(); // 點擊空白處關閉選單
		return;
	}

	// 3. 尋找並點擊尚未轉發的「Repost / 轉推」選項
	const repostItem = menuItems.find((item) => {
		const text = item.innerText || '';
		return (
			(text.includes('Repost') || text.includes('轉推') || text.includes('轉發')) &&
			!text.includes('Quote') &&
			!text.includes('引用') &&
			!text.includes('SNS')
		);
	});

	if (repostItem) {
		repostItem.click();
	} else {
		document.body.click();
	}
}

// 監聽 Twitter 原生轉發選單彈出，並以原汁原味的結構劫持注入「Repost to other SNS」選項
function observeTwitterDropdownMenu() {
	const dropdown = document.querySelector('[data-testid="Dropdown"]');
	if (!dropdown || dropdown.dataset.crosspostInjected) return;

	// 尋找選單內的第一個原生項目作為模板（Clone Template）
	const menuItems = Array.from(dropdown.querySelectorAll('[role="menuitem"]'));
	const templateItem = menuItems[0];
	if (!templateItem) return;

	// 檢查選單內是否屬於轉發相關選單 (Repost / Undo Repost / Quote)
	const isRetweetMenu = menuItems.some((item) => {
		const txt = item.innerText || '';
		return (
			txt.includes('Repost') ||
			txt.includes('轉推') ||
			txt.includes('轉發') ||
			txt.includes('Quote') ||
			txt.includes('引用') ||
			txt.includes('Undo')
		);
	});

	if (!isRetweetMenu) return;
	dropdown.dataset.crosspostInjected = 'true';

	// 尋找觸發此選單的推文 (<article>)
	const activeTriggerBtn = document.querySelector(
		'[data-testid="retweet"][aria-expanded="true"], [data-testid="unretweet"][aria-expanded="true"]'
	);
	const article = activeTriggerBtn?.closest('article');

	// 取得來源推文網址
	const timeLink = article?.querySelector('time')?.closest('a');
	const statusLink = article?.querySelector('a[href*="/status/"]');
	const tweetUrl = timeLink?.href || statusLink?.href;

	// 核心改進：直接 clone 原生選單項目，完整繼承原生外層與內層所有 class 與字型結構
	const customMenuItem = templateItem.cloneNode(true);

	// 1. 替換文字內容，保留所有原生字型 class
	const textContainer = customMenuItem.querySelector('span, div[dir="ltr"]');
	if (textContainer) {
		// 找出最深層的純文字節點直接替換
		const deepestSpan = customMenuItem.querySelector('span:not(:has(*))') || textContainer;
		deepestSpan.innerText = 'Repost to other SNS (Bsky)';
	}

	// 2. 劫持圖示：將 SVG 圖標換上轉發 path，並維持原生 SVG 的 class、尺寸與排版
	const svgEl = customMenuItem.querySelector('svg');
	if (svgEl) {
		svgEl.setAttribute('viewBox', '0 0 24 24');
		svgEl.style.color = 'rgb(29, 155, 240)';
		svgEl.style.fill = 'currentColor';
		svgEl.innerHTML = `
			<g>
				<path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"></path>
			</g>
		`;
	}

	// 3. 綁定自訂點擊動作
	customMenuItem.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();

		// 關閉 Twitter 原生下拉選單
		document.body.click();

		if (tweetUrl && article) {
			openCrosspostRepostModal(tweetUrl, article);
		} else {
			alert('無法取得該貼文的完整網址');
		}
	};

	// 插入到選單的最末尾
	dropdown.appendChild(customMenuItem);
}

// 計算字串在 UTF-8 編碼下的 Byte 長度
function getUtf8ByteLength(str) {
	return new TextEncoder().encode(str).byteLength;
}

/**
 * 將文字中的所有 URL 取代為指定錨文字（預設為 'link'）
 * 同時精確計算每段 'link' 的 UTF-8 Byte 範圍並產生 app.bsky.richtext.facet
 *
 * @param {string} originalText 原始貼文內文
 * @param {string} anchorText 替代顯示文字，預設為 'link'
 * @returns {{ text: string, facets: Array|undefined }}
 */
function replaceUrlsWithLinkFacets(originalText, anchorText = 'link') {
	if (!originalText) return { text: '', facets: undefined };

	const urlRegex = /https?:\/\/[^\s]+/g;
	const facets = [];
	
	let newText = '';
	let lastIndex = 0;
	let match;

	const anchorByteLen = getUtf8ByteLength(anchorText);

	while ((match = urlRegex.exec(originalText)) !== null) {
		const rawUrl = match[0];
		const matchStart = match.index;

		// 1. 將上一個位置到當前符合項目之間的純文字追加進 newText
		const precedingText = originalText.slice(lastIndex, matchStart);
		newText += precedingText;

		// 2. 計算當前 'link' 文字的起始 UTF-8 Byte 位移
		const currentByteStart = getUtf8ByteLength(newText);
		const currentByteEnd = currentByteStart + anchorByteLen;

		// 3. 追加替代的錨點文字（例如 'link'）
		newText += anchorText;

		// 4. 建立符合 AT Protocol 規範的 facet
		facets.push({
			index: {
				byteStart: currentByteStart,
				byteEnd: currentByteEnd,
			},
			features: [
				{
					$type: 'app.bsky.richtext.facet#link',
					uri: rawUrl,
				},
			],
		});

		lastIndex = matchStart + rawUrl.length;
	}

	// 追加最後剩餘的文字
	newText += originalText.slice(lastIndex);

	return {
		text: newText,
		facets: facets.length > 0 ? facets : undefined,
	};
}

// 從目標推文的 <article> 中提取 Title、Description 與第一張圖片 Blob
async function extractTweetDetailsFromArticle(article) {
	let title = 'Post on X';
	let description = '';
	let thumbBlob = null;

	if (!article) return { title, description, thumbBlob };

	// 1. 劫持作者資訊 (Title)
	// Twitter 結構: [data-testid="User-Name"] 內有「顯示名稱」與「@handle」
	const userNameEl = article.querySelector('[data-testid="User-Name"]');
	if (userNameEl) {
		const rawLines = (userNameEl.innerText || '').split('\n').filter(Boolean);
		const displayName = rawLines[0] || '';
		const handle = rawLines.find((l) => l.startsWith('@')) || '';
		if (displayName && handle) {
			title = `${displayName} (${handle}) on X`;
		} else if (displayName) {
			title = `${displayName} on X`;
		}
	}

	// 2. 劫持推文文字 (Description)
	const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
	if (tweetTextEl) {
		description = tweetTextEl.innerText.trim();
	}

	// 3. 劫持第一張圖片 (Thumb)
	// Twitter 的圖片大多是 img[src*="pbs.twimg.com/media/"] 或帶有 blob: 的縮圖
	const imgEl = article.querySelector('div[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]');
	if (imgEl && imgEl.src) {
		try {
			// 替換 Twitter 縮圖網址為較高畫質/標準 jpeg 格式以利抓取
			let imgSrc = imgEl.src;
			if (imgSrc.includes('format=')) {
				imgSrc = imgSrc.replace(/format=[a-zA-Z0-9]+/, 'format=jpg');
			}
			const response = await fetch(imgSrc);
			if (response.ok) {
				thumbBlob = await response.blob();
			}
		} catch (e) {
			console.warn('[Crosspost] 抓取推文縮圖 Blob 失敗:', e);
		}
	}

	return { title, description, thumbBlob };
}



init();