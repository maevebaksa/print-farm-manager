// Mirror of auth.js's canModifyWork: a user may delete or cancel their own
// work, and someone else's only with can_manage_others_work. The server is the
// enforcer; this only hides controls that would 403.
export function canModifyWork(user, ownerId) {
  if (!user) return false;
  const others = user.permissions?.can_manage_others_work ?? (user.role === 'admin' || user.role === 'operator');
  return others || (ownerId != null && Number(ownerId) === Number(user.id));
}
