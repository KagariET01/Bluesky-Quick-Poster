const authSection = document.getElementById('auth-section');
const postSection = document.getElementById('post-section');
const handleInput = document.getElementById('handle');
const appPasswordInput = document.getElementById('app-password');
const saveAuthBtn = document.getElementById('save-auth-btn');
const postText = document.getElementById('post-text');
const submitPostBtn = document.getElementById('submit-post-btn');
const statusDiv = document.getElementById('status');
const userDisplay = document.getElementById('user-display');
const logoutBtn = document.getElementById('logout-btn');

// 初始化：檢查是否已儲存帳號金鑰
chrome.storage.local.get(['handle', 'appPassword'], (result) => {
	if (result.handle && result.appPassword) {
		showPostUI(result.handle);
	} else {
		showAuthUI();
	}
});

function showAuthUI() {
	authSection.classList.remove('hidden');
	postSection.classList.add('hidden');
	statusDiv.textContent = '';
}

function showPostUI(handle) {
	authSection.classList.add('hidden');
	postSection.classList.remove('hidden');
	userDisplay.textContent = `@${handle}`;
	statusDiv.textContent = '';
	postText.focus();
}

// 儲存金鑰並測試連線
saveAuthBtn.addEventListener('click', async () => {
	const handle = handleInput.value.trim();
	const appPassword = appPasswordInput.value.trim();

	if (!handle || !appPassword) {
		statusDiv.textContent = '請填寫完整的 Handle 與 App Password';
		return;
	}

	statusDiv.textContent = '驗證連線中...';
	try {
		// 透過建立 Session 測試認證是否有效
		await createSession(handle, appPassword);
		chrome.storage.local.set({ handle, appPassword }, () => {
			showPostUI(handle);
		});
	} catch (err) {
		statusDiv.textContent = `認證失敗：${err.message}`;
	}
});

// 清除登入設定
logoutBtn.addEventListener('click', () => {
	chrome.storage.local.remove(['handle', 'appPassword', 'accessJwt', 'did'], () => {
		showAuthUI();
	});
});

// 發文邏輯
submitPostBtn.addEventListener('click', async () => {
	const text = postText.value.trim();
	if (!text) return;

	submitPostBtn.disabled = true;
	statusDiv.textContent = '貼文中...';

	try {
		const { handle, appPassword } = await chrome.storage.local.get(['handle', 'appPassword']);
		
		// 1. 取得或刷新 Session
		const session = await createSession(handle, appPassword);

		// 2. 呼叫 com.atproto.repo.createRecord 發布貼文
		await postToBluesky(session.accessJwt, session.did, text);

		statusDiv.textContent = '發布成功！';
		postText.value = '';
		setTimeout(() => {
			window.close(); // 成功後關閉彈窗
		}, 1000);
	} catch (err) {
		statusDiv.textContent = `發文失敗：${err.message}`;
	} finally {
		submitPostBtn.disabled = false;
	}
});

// XRPC: com.atproto.server.createSession
async function createSession(identifier, password) {
	const res = await fetch('https://bsky.kandayuri.net/xrpc/com.atproto.server.createSession', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier, password })
	});
	if (!res.ok) {
		const errorData = await res.json();
		throw new Error(errorData.message || '登入失敗');
	}
	return await res.json();
}

// XRPC: com.atproto.repo.createRecord
async function postToBluesky(jwt, did, text) {
	const res = await fetch('https://bsky.kandayuri.net/xrpc/com.atproto.repo.createRecord', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${jwt}`
		},
		body: JSON.stringify({
			repo: did,
			collection: 'app.bsky.feed.post',
			record: {
				$type: 'app.bsky.feed.post',
				text: text,
				createdAt: new Date().toISOString()
			}
		})
	});
	if (!res.ok) {
		const errorData = await res.json();
		throw new Error(errorData.message || '無法建立貼文記錄');
	}
	return await res.json();
}
