import { useNavigate } from "react-router-dom"
import type { EvolutionSource } from "@/lib/factor-evolution-api"

export function EvolutionButton({source, className = ""}: {source: EvolutionSource; className?: string}) {
  const navigate = useNavigate()
  return <button type="button" className={`text-[10px] text-[var(--primary)] hover:underline whitespace-nowrap ${className}`} onClick={event => {
    event.stopPropagation()
    navigate("/factor-lab/evolution", {state: {evolutionTarget: source, nonce: Date.now()}})
  }}>LLM 调整进化</button>
}
