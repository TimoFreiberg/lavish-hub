globalThis.confirmDraftNavigation = function (message) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('data-lavish-action', '');
    dialog.setAttribute('aria-labelledby', 'draft-navigation-title');
    dialog.style.cssText = 'max-width:32rem;padding:1.5rem;border:1px solid #777;border-radius:.5rem;background:#171923;color:white;font:16px system-ui';
    const title = document.createElement('h2'); title.id = 'draft-navigation-title'; title.textContent = 'Leave with unsaved edits?';
    const description = document.createElement('p'); description.textContent = message;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Keep editing';
    const leave = document.createElement('button'); leave.type = 'button'; leave.textContent = 'Leave page'; leave.style.marginLeft = '1rem';
    dialog.append(title, description, cancel, leave); document.body.append(dialog);
    let confirmed = false;
    cancel.addEventListener('click', () => dialog.close());
    leave.addEventListener('click', () => { confirmed = true; dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (!confirmed && previous?.isConnected) previous.focus(); resolve(confirmed); }, { once: true });
    dialog.showModal(); cancel.focus();
  });
};
