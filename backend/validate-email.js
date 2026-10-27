// Keep the existing simple email shape, but cap work and avoid backtracking.
// The application accepts at most 254 characters; this is not an RFC parser.
module.exports = (email) => {
  if (typeof email !== 'string' || email.length > 254 || /\s/.test(email)) return false;
  const parts = email.split('@');
  return parts.length === 2 && parts[0].length > 0 &&
    parts[1].slice(1, -1).includes('.');
};
