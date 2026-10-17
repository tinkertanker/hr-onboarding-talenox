// The app sends plain-text email only. Aliasing Resend's optional React renderer
// to this stub keeps React and Prettier out of the Worker bundle.
export const renderAsync = () => {
  throw new Error('React email rendering is not bundled');
};
export const render = renderAsync;
