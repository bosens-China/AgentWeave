import { useMemo } from 'react'
import { Tree } from 'antd'
import type { TreeDataNode } from 'antd'

function buildPluginTree(files: string[]): TreeDataNode[] {
  const nodes: TreeDataNode[] = []
  for (const path of files) {
    const parts = path.split('/')
    let children = nodes
    for (let index = 0; index < parts.length; index++) {
      const key = parts.slice(0, index + 1).join('/')
      let node = children.find((item) => item.key === key)
      if (!node) {
        const isLeaf = index === parts.length - 1
        node = {
          key,
          title: parts[index],
          isLeaf,
          selectable: isLeaf,
          ...(!isLeaf && { children: [] }),
        }
        children.push(node)
      }
      if (node.children) children = node.children
    }
  }
  return nodes
}

export function PluginFileTree({
  files,
  selected,
  onSelect,
}: {
  files: string[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  const treeData = useMemo(() => buildPluginTree(files), [files])
  return (
    <Tree
      aria-label="插件文件"
      blockNode
      showLine
      selectedKeys={selected ? [selected] : []}
      treeData={treeData}
      onSelect={(_, info) => {
        if (info.node.isLeaf) onSelect(String(info.node.key))
      }}
    />
  )
}
