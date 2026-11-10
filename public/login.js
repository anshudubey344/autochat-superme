const form = document.getElementById('loginForm');
const err = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');
const codeBox = document.getElementById('codeBox');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: form.elements.user.value, password: form.elements.password.value, code: form.elements.code.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.needCode && codeBox.hidden) {          // password was right; ask for the 2-step code
      codeBox.hidden = false; form.elements.code.required = true; form.elements.code.focus();
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Sign in failed');
    location.replace('/');
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    form.elements.code.value = '';
    if (codeBox.hidden) { form.elements.password.value = ''; form.elements.password.focus(); } else form.elements.code.focus();
  } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
});
