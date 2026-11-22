let activeOverlayCleanup: (() => void) | null = null;

export function closeYouTubePlayerOverlay(): void {
  if (activeOverlayCleanup) {
    activeOverlayCleanup();
    activeOverlayCleanup = null;
  }
}

export function openExternalUrlSafely(url: string): void {
  if (!url) return;
  const anchor = document.createElement('a');
  anchor.href = url;
  if (!url.startsWith('intent://')) {
    anchor.target = '_blank';
  }
  anchor.rel = 'noopener noreferrer';
  anchor.click();
}

export function openYouTubePlayerOverlay(videoId: string, title: string): void {
  closeYouTubePlayerOverlay();

  const backdrop = document.createElement('div');
  backdrop.className = 'vr-modal-backdrop';

  const card = document.createElement('div');
  card.className = 'vr-modal-card';

  const header = document.createElement('div');
  header.className = 'vr-modal-header';

  const heading = document.createElement('h2');
  heading.className = 'vr-modal-title';
  heading.textContent = title || 'YouTube VR Theater';

  const actions = document.createElement('div');
  actions.className = 'vr-modal-actions';

  const watchExternal = document.createElement('a');
  watchExternal.className = 'vr-modal-link';
  watchExternal.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  watchExternal.target = '_blank';
  watchExternal.rel = 'noopener noreferrer';
  watchExternal.textContent = 'Open on YouTube';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'vr-modal-close';
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';

  actions.append(watchExternal, closeBtn);
  header.append(heading, actions);

  const iframe = document.createElement('iframe');
  iframe.className = 'vr-modal-frame';
  iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0`;
  iframe.title = title || 'YouTube Video Player';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;

  card.append(header, iframe);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeYouTubePlayerOverlay();
    }
  };
  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === backdrop) {
      closeYouTubePlayerOverlay();
    }
  };
  closeBtn.addEventListener('click', closeYouTubePlayerOverlay);
  backdrop.addEventListener('click', onBackdropClick);
  window.addEventListener('keydown', onKeyDown);

  activeOverlayCleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    backdrop.removeEventListener('click', onBackdropClick);
    closeBtn.removeEventListener('click', closeYouTubePlayerOverlay);
    iframe.src = 'about:blank';
    backdrop.remove();
  };
}

export function openLiveSearchPromptModal(options: {
  title: string;
  placeholder: string;
  initialValue: string;
  onSubmit: (value: string) => void;
}): void {
  closeYouTubePlayerOverlay();

  const backdrop = document.createElement('div');
  backdrop.className = 'vr-modal-backdrop';

  const card = document.createElement('div');
  card.className = 'vr-modal-card vr-query-card';

  const header = document.createElement('div');
  header.className = 'vr-modal-header';

  const heading = document.createElement('h2');
  heading.className = 'vr-modal-title';
  heading.textContent = options.title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'vr-modal-close';
  closeBtn.type = 'button';
  closeBtn.textContent = 'Cancel';

  header.append(heading, closeBtn);

  const form = document.createElement('form');
  form.className = 'vr-query-form';

  const input = document.createElement('input');
  input.className = 'vr-query-input';
  input.type = 'text';
  input.placeholder = options.placeholder;
  input.value = options.initialValue;

  const submitBtn = document.createElement('button');
  submitBtn.className = 'vr-query-submit';
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Go';

  form.append(input, submitBtn);
  card.append(header, form);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  setTimeout(() => {
    input.focus();
    input.select();
  }, 20);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeYouTubePlayerOverlay();
    }
  };
  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === backdrop) {
      closeYouTubePlayerOverlay();
    }
  };
  const onSubmit = (e: Event) => {
    e.preventDefault();
    const val = input.value.trim();
    closeYouTubePlayerOverlay();
    if (val) {
      options.onSubmit(val);
    }
  };

  closeBtn.addEventListener('click', closeYouTubePlayerOverlay);
  backdrop.addEventListener('click', onBackdropClick);
  form.addEventListener('submit', onSubmit);
  window.addEventListener('keydown', onKeyDown);

  activeOverlayCleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    backdrop.removeEventListener('click', onBackdropClick);
    form.removeEventListener('submit', onSubmit);
    closeBtn.removeEventListener('click', closeYouTubePlayerOverlay);
    backdrop.remove();
  };
}
