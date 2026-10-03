// Props that make a non-<button> element behave as a real button: focusable, announced as a button, and
// activated by Enter or Space as well as click. Use only where the element holds block children a <button> can't.
export function buttonProps(onActivate, label) {
    return {
        role: 'button',
        tabIndex: 0,
        'aria-label': label,
        onClick: onActivate,
        onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate(e);
            }
        },
    };
}
