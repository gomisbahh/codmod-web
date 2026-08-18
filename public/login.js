// Client-side Authentication Logic for Google Codmod Web Wrapper

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const passcodeField = document.getElementById('passcode');
  const loginBtn = document.getElementById('login-btn');
  const errorMessage = document.getElementById('error-message');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const password = passcodeField.value.trim();
    if (!password) return;

    try {
      // Show loading state
      loginBtn.disabled = true;
      loginBtn.querySelector('span').textContent = 'Authenticating...';
      errorMessage.setAttribute('hidden', '');

      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Login failed');
      }

      // Success! Redirect to the main dashboard
      window.location.href = '/';

    } catch (err) {
      console.error('Login error:', err);
      errorMessage.textContent = err.message;
      errorMessage.removeAttribute('hidden');
      
      // Select passcode field for quick re-entry
      passcodeField.select();
    } finally {
      loginBtn.disabled = false;
      loginBtn.querySelector('span').textContent = 'Unlock Dashboard';
    }
  });
});
