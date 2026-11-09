const form = document.getElementById('form');
const submit = document.getElementById('submit');
const buttonText = document.getElementById('buttonText');
const status = document.getElementById('status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  status.className = 'status';
  status.textContent = 'Otwieram stronę, wykonuję dwa zrzuty i zbieram grafiki. Może to potrwać kilkadziesiąt sekund…';
  buttonText.textContent = 'Archiwizuję stronę…';
  try {
    const response = await fetch('/api/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': document.getElementById('key').value },
      body: JSON.stringify({ url: document.getElementById('url').value.trim() })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Błąd serwera: ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || 'archiwum.zip';
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);
    status.textContent = 'Gotowe! ZIP został przygotowany i pobrany.';
  } catch (error) {
    status.className = 'status error';
    status.textContent = error.message || 'Nie udało się przygotować archiwum.';
  } finally {
    submit.disabled = false;
    buttonText.textContent = 'Przygotuj archiwum ZIP';
  }
});
