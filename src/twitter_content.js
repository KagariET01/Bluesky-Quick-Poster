// 自架 PDS 位址
const PDS_URL = 'https://bsky.kandayuri.net';

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
			// injectGreenButton();
			setupCustomBottomBar();
			bindShortcutKeys();
			validatePostReadiness(); // 即時動態判定按鈕啟用狀態
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

// 2. 嚴格限定：只在「建立貼文彈窗」或「首頁頂部(/home)主發文區」生效，徹底排除所有推文回覆欄
function setupCustomBottomBar() {
	const modal = document.querySelector('[aria-labelledby="modal-header"][role="dialog"]');

	let targetRoot = null;
	let nativeSubmitBtn = null;

	if (modal) {
		// 排除回覆（Reply）彈窗
		const isReply =
			modal.querySelector('[data-testid="tweetTextarea_0_label"]')?.innerText?.includes('reply') ||
			modal.innerText.includes('Replying to') ||
			modal.innerText.includes('回覆給') ||
			modal.querySelector('[data-testid="tweetTextarea_0"]')?.getAttribute('aria-label')?.includes('reply');

		if (isReply) return;

		targetRoot = modal;
		nativeSubmitBtn = modal.querySelector('[data-testid="tweetButton"]');
	} else {
		// 嚴格限制：非彈窗模式下，必須在首頁 (/home 或根目錄) 才允許掛載，其餘貼文詳細頁 (/status/...) 直接退出
		const path = window.location.pathname;
		const isHomePage = path === '/home' || path === '/';
		if (!isHomePage) return;

		// 尋找首頁最上方 (Top) 的主發文按鈕，並嚴格過濾排除包含任何 reply 特徵的區塊
		const inlineButtons = Array.from(document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'));
		for (const btn of inlineButtons) {
			// 若按鈕位於推文主體或帶有回覆文字的區塊內，直接排除
			const replyContainer = btn.closest('article, [data-testid="cellInnerDiv"]');
			const isReplyBox = replyContainer && (
				replyContainer.innerText.includes('Replying to') || 
				replyContainer.innerText.includes('回覆給') ||
				replyContainer.innerText.includes('Post your reply') ||
				replyContainer.innerText.includes('發布你的回覆')
			);

			if (!isReplyBox) {
				// 確保該輸入框確實是首頁頂端發文框（對應 placeholder 為 "What is happening?!" 或 "有什麼新鮮事？"）
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

	// 採用指定的 4 層父容器鎖定
	const buttonHost = nativeSubmitBtn.parentElement.parentElement.parentElement.parentElement;
	if (!buttonHost) return;

	buttonHost.style.margin = '0';

	// 避免重複掛載
	if (buttonHost.querySelector('#crosspost-toolbar-row')) {
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
	if (span) span.innerText = originalText;
	if (btn) btn.style.pointerEvents = 'auto';
	updatePlatformButtonsStyle();
	validatePostReadiness();
}

// 5. DOM 貼文與多媒體精確擷取
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

	return results;
}

// 6. 登入取得 Bluesky Session
async function getBskySession() {
	if (!chrome.runtime?.id) {
		throw new Error('擴充功能已重新載入，請按 F5 重新整理頁面！');
	}

	const { handle, appPassword } = await chrome.storage.local.get(['handle', 'appPassword']);
	if (!handle || !appPassword) throw new Error('擴充功能中尚未設定 Bluesky Handle 或 App Password');

	const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier: handle, password: appPassword }),
	});

	if (!res.ok) throw new Error('Bluesky 登入驗證失敗');
	return await res.json();
}

// 7. 上傳圖片 Blob 到自架 PDS
async function uploadBlobToPDS(jwt, blob) {
	const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.uploadBlob`, {
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

// 8. 發布貼文至 Bluesky
async function postThreadToBluesky(postsData) {
	const session = await getBskySession();
	const jwt = session.accessJwt;
	const did = session.did;

	let rootRef = null;
	let parentRef = null;

	for (let i = 0; i < postsData.length; i++) {
		const postItem = postsData[i];

		let embed = undefined;
		if (postItem.images && postItem.images.length > 0) {
			const uploadedImages = [];
			for (const imgBlob of postItem.images) {
				const pdsBlobRef = await uploadBlobToPDS(jwt, imgBlob);
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

		const record = {
			$type: 'app.bsky.feed.post',
			text: postItem.text,
			createdAt: new Date().toISOString(),
		};

		if (embed) {
			record.embed = embed;
		}

		if (rootRef && parentRef) {
			record.reply = {
				root: { uri: rootRef.uri, cid: rootRef.cid },
				parent: { uri: parentRef.uri, cid: parentRef.cid },
			};
		}

		const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
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

init();