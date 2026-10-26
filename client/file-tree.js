// Groups a PR's files into a directory tree for the review sidebar.
// A directory whose only content is one subdirectory is merged with it into a single row
// ("packages/api/src"), like GitHub's file tree.

const byName = (a, b) => a.name.localeCompare(b.name);
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * @param {{ name: string }[]} files  `name` is the file's full path
 * @returns {{ name: string, path: string, dirs: object[], files: object[] }} the root directory
 */
export function buildFileTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    let node = root;
    for (const part of file.name.split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return finish(root);
}

function finish(node) {
  const dirs = [...node.dirs.values()].map(finish).sort(byName).map((dir) => {
    let merged = dir;
    while (merged.dirs.length === 1 && merged.files.length === 0) {
      const only = merged.dirs[0];
      merged = { ...only, name: `${merged.name}/${only.name}` };
    }
    return merged;
  });
  const files = [...node.files].sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
  return { name: node.name, path: node.path, dirs, files };
}

/** Every file under a directory, in tree order. */
export function filesUnder(dir) {
  return [...dir.dirs.flatMap(filesUnder), ...dir.files];
}

/** All files in tree order (folders first, depth-first), so the diff scrolls in the same order as the tree. */
export const treeOrder = filesUnder;
