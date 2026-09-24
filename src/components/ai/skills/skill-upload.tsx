"use client"

import { useRef, useState } from "react"
import { Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { uploadSkill } from "@/lib/api"
import { showAlert } from "@/stores/dialog"

/** 上传 SKILL.md 组件 */
export function SkillUpload({ onSuccess }: { onSuccess: () => void }): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")
  const [triggerWord, setTriggerWord] = useState("")
  const [description, setDescription] = useState("")
  const [uploading, setUploading] = useState(false)

  async function handleSubmit(): Promise<void> {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      await showAlert({ title: "提示", description: "请选择 SKILL.md 文件" })
      return
    }
    if (!name.trim() || !triggerWord.trim()) {
      await showAlert({ title: "提示", description: "请填写名称和触发词" })
      return
    }

    setUploading(true)
    try {
      await uploadSkill(file, name.trim(), triggerWord.trim(), description.trim())
      setName("")
      setTriggerWord("")
      setDescription("")
      if (fileRef.current) fileRef.current.value = ""
      onSuccess()
    } catch (err) {
      await showAlert({ title: "上传失败", description: err instanceof Error ? err.message : "上传失败", variant: "destructive" })
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3 p-4 rounded-lg border border-[var(--border)]">
      <h4 className="text-sm font-medium">上传自定义 Skill</h4>
      <div className="grid grid-cols-2 gap-3">
        <Input
          placeholder="Skill 名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder="触发词"
          value={triggerWord}
          onChange={(e) => setTriggerWord(e.target.value)}
        />
      </div>
      <Input
        placeholder="描述（可选）"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".md"
          className="flex-1 text-sm text-[var(--text-muted)] file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-[var(--secondary)] file:text-[var(--text-secondary)] hover:file:bg-[var(--accent)]"
        />
        <Button size="sm" onClick={handleSubmit} disabled={uploading}>
          <Upload className="w-3.5 h-3.5 mr-1" />
          {uploading ? "上传中..." : "上传"}
        </Button>
      </div>
    </div>
  )
}
