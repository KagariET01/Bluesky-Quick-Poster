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

// 初始化：檢查是否已儲存帳號身分與 App Password
chrome.storage.local.get(['did', 'handle', 'appPassword'], async (result) => {
  if (result.did && result.appPassword) {
    showPostUI(result.did);
  } else {
    showAuthUI();
  }
});

function showAuthUI() {
  authSection.classList.remove('hidden');
  postSection.classList.add('hidden');
  statusDiv.textContent = '';
}

// 根據 DID 取得公開個人資料並渲染 user-display
async function showPostUI(did) {
  authSection.classList.add('hidden');
  postSection.classList.remove('hidden');
  statusDiv.textContent = '';
  postText.focus();

  // 先顯示讀取中或預設 DID
  userDisplay.textContent = '載入使用者資料中...';

  try {
    const profile = await fetchProfileByDid(did);
    const displayName = profile.displayName || profile.handle || did;
    const handle = profile.handle || '';
    const avatarUrl = profile.avatar;

    // 清空並重新構建 user-display 結構：(大頭貼)使用者名稱(@handle.bsky.app)
    userDisplay.innerHTML = '';
    userDisplay.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; vertical-align: middle;';

    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.style.cssText = 'width: 22px; height: 22px; border-radius: 50%; object-fit: cover;';
      userDisplay.appendChild(img);
    }

    const textSpan = document.createElement('span');
    textSpan.style.cssText = 'font-size: 13px; font-weight: bold;';
    textSpan.textContent = `${displayName}(@${handle})`;
    userDisplay.appendChild(textSpan);
  } catch (err) {
    console.warn('取得 Profile 失敗，回退純文字顯示:', err);
    userDisplay.textContent = did;
  }
}

// 核心函式：將三種格式 (@handle, handle, did:plc:...) 自動轉換為 DID
async function normalizeToDid(input) {
  let cleanInput = input.trim();

  // 1. 若已經是 did: 開頭（did:plc:aaaaaa 或 did:web:...）
  if (cleanInput.startsWith('did:')) {
    return cleanInput;
  }

  // 2. 若帶有 @ 開頭（@handle.bsky.app），去除開頭 @
  if (cleanInput.startsWith('@')) {
    cleanInput = cleanInput.slice(1);
  }

  // 3. 透過公開 API 解析 handle 為 DID
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanInput)}`
  );
  if (!res.ok) {
    throw new Error(`無法解析該 Handle (@${cleanInput}) 的身份 DID`);
  }
  const data = await res.json();
  return data.did;
}

// 透過 DID 取得使用者公開資料 (Display Name, Handle, Avatar)
async function fetchProfileByDid(did) {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
  );
  if (!res.ok) {
    throw new Error('無法讀取 Profile 資料');
  }
  return await res.json();
}

// 儲存金鑰並測試連線
saveAuthBtn.addEventListener('click', async () => {
  const rawInput = handleInput.value.trim();
  const appPassword = appPasswordInput.value.trim();

  if (!rawInput || !appPassword) {
    statusDiv.textContent = '請填寫完整的帳號識別碼與 App Password';
    return;
  }

  statusDiv.textContent = '身分解析與驗證中...';
  try {
    // 1. 自動辨識並轉換成 DID
    const did = await normalizeToDid(rawInput);

    // 2. 解析該帳號所屬的動態 PDS 端點
    const pdsUrl = await resolvePdsUrlByDid(did);

    // 3. 使用 DID 與 App Password 登入測試
    const session = await createSession(pdsUrl, did, appPassword);

    // 4. 存入 local storage (儲存 did 與 handle)
    await chrome.storage.local.set({
      did: session.did,
      handle: session.handle,
      appPassword: appPassword,
    });

    showPostUI(session.did);
  } catch (err) {
    statusDiv.textContent = `認證失敗：${err.message}`;
  }
});

// 清除登入設定
logoutBtn.addEventListener('click', () => {
  chrome.storage.local.remove(['did', 'handle', 'appPassword'], () => {
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
    const { did, appPassword } = await chrome.storage.local.get(['did', 'appPassword']);
    if (!did || !appPassword) throw new Error('尚未完成登入設定');

    const pdsUrl = await resolvePdsUrlByDid(did);
    const session = await createSession(pdsUrl, did, appPassword);

    await postToBluesky(pdsUrl, session.accessJwt, session.did, text);

    statusDiv.textContent = '發布成功！';
    postText.value = '';
    setTimeout(() => {
      window.close();
    }, 1000);
  } catch (err) {
    statusDiv.textContent = `發文失敗：${err.message}`;
  } finally {
    submitPostBtn.disabled = false;
  }
});

// 根據 DID 自動解析權威 PDS 伺服器網址
async function resolvePdsUrlByDid(did) {
  const cacheKey = `pds_url_${did}`;
  const cached = await chrome.storage.local.get([cacheKey]);
  if (cached[cacheKey]) return cached[cacheKey];

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

  if (!pdsUrl) throw new Error('找不到該帳號綁定的 PDS 服務端點');
  pdsUrl = pdsUrl.replace(/\/+$/, '');
  await chrome.storage.local.set({ [cacheKey]: pdsUrl });
  return pdsUrl;
}

// XRPC: com.atproto.server.createSession (identifier 可直接使用 DID)
async function createSession(pdsUrl, identifier, password) {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.message || '登入失敗');
  }
  return await res.json();
}

// XRPC: com.atproto.repo.createRecord
async function postToBluesky(pdsUrl, jwt, did, text) {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      repo: did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: text,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) {
    throw new Error('無法建立貼文記錄');
  }
  return await res.json();
}