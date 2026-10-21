// Folder-based access control.
//
// Each folder may carry permission entries (user or group, read or write). A folder without
// entries inherits from its nearest ancestor that has some; when no ancestor has any, the
// folder is open to every user. Documents outside any folder are open to everyone.

const LEVELS = { read: 1, write: 2 };

function loadFolders(db) {
  const folders = new Map(
    db.prepare('SELECT id, name, parent_id FROM folders').all().map((f) => [f.id, { ...f, permissions: [] }])
  );
  for (const p of db.prepare('SELECT * FROM folder_permissions').all()) folders.get(p.folder_id)?.permissions.push(p);
  return folders;
}

function folderPath(folders, id) {
  const names = [];
  for (let f = folders.get(id), guard = 0; f && guard < 100; f = folders.get(f.parent_id), guard++) names.unshift(f.name);
  return names.join(' / ');
}

// Returns 'write', 'read' or null for the given user on a folder (null id = root).
function folderLevel(folders, user, id) {
  if (user.is_admin || id == null) return 'write';
  for (let f = folders.get(id), guard = 0; f && guard < 100; f = folders.get(f.parent_id), guard++) {
    if (f.permissions.length === 0) continue;
    let best = null;
    for (const p of f.permissions) {
      const matches = p.subject_type === 'user' ? p.subject_id === user.id : user.group_ids.includes(p.subject_id);
      if (matches && (!best || LEVELS[p.level] > LEVELS[best])) best = p.level;
    }
    return best;
  }
  return 'write';
}

function readableFolderIds(folders, user) {
  return [...folders.keys()].filter((id) => folderLevel(folders, user, id));
}

function descendantIds(folders, id) {
  const result = [id];
  for (let i = 0; i < result.length; i++) {
    for (const f of folders.values()) if (f.parent_id === result[i]) result.push(f.id);
  }
  return result;
}

module.exports = { loadFolders, folderPath, folderLevel, readableFolderIds, descendantIds };
