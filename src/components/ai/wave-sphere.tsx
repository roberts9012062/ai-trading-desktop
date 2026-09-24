"use client"

/**
 * 玻璃球半满蓝色液体 —— 波浪液面 + 渐变融合无硬边界
 */

import { cn } from "@/lib/utils"

/** 玻璃液体球 */
export function WaveSphere(props: {
  className?: string
  size?: number
  compact?: boolean
}): React.JSX.Element {
  const size = props.size ?? 56

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-full",
        "transition-transform duration-300 ease-out",
        props.compact ? "scale-90" : "scale-100",
        props.className
      )}
      style={{
        width: size,
        height: size,
        background:
          "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.22) 0%, rgba(180,200,220,0.08) 28%, rgba(20,28,40,0.55) 70%, rgba(8,12,20,0.85) 100%)",
        border: "1px solid rgba(180, 200, 220, 0.35)",
        boxShadow: `
          0 4px 14px rgba(0,0,0,0.4),
          inset 0 1px 1px rgba(255,255,255,0.35),
          inset 0 -2px 6px rgba(0,0,0,0.25)
        `,
      }}
      aria-hidden
    >
      {/* 内腔 */}
      <div
        className="absolute inset-[2px] rounded-full overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 50% 40%, #0c1520 0%, #060a10 100%)",
        }}
      >
        {/* 液体翻滚容器 */}
        <div
          className="absolute inset-[-25%] animate-[ai-liquid-tumble_5s_ease-in-out_infinite]"
          style={{ transformOrigin: "50% 58%" }}
        >
          <div
            className="absolute left-[-40%] right-[-40%] bottom-0"
            style={{ height: "72%" }}
          >
            {/* 底层液体：自上而下柔和渐变，无硬边 */}
            <div
              className="absolute left-0 right-0 bottom-0"
              style={{
                height: "70%",
                background:
                  "linear-gradient(180deg, rgba(56,189,248,0.15) 0%, rgba(14,165,233,0.75) 18%, #0ea5e9 40%, #0284c7 68%, #0369a1 100%)",
              }}
            />

            {/* 主波浪：半透明 + 模糊，与下层融合 */}
            <svg
              className="absolute left-0 w-[200%] h-[58%] animate-[ai-wave-scroll-a_2.8s_linear_infinite]"
              style={{
                bottom: "42%",
                filter: "blur(1.2px)",
                opacity: 0.85,
              }}
              viewBox="0 0 240 60"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="aiWaveA" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#7dd3fc" stopOpacity="0.55" />
                  <stop offset="35%" stopColor="#38bdf8" stopOpacity="0.75" />
                  <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.9" />
                </linearGradient>
              </defs>
              <path fill="url(#aiWaveA)">
                <animate
                  attributeName="d"
                  dur="1.8s"
                  repeatCount="indefinite"
                  calcMode="spline"
                  keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"
                  keyTimes="0;0.5;1"
                  values="
                    M0,30 C20,8 40,52 60,30 C80,8 100,52 120,30 C140,8 160,52 180,30 C200,8 220,52 240,30 L240,60 L0,60 Z;
                    M0,30 C20,52 40,8 60,30 C80,52 100,8 120,30 C140,52 160,8 180,30 C200,52 220,8 240,30 L240,60 L0,60 Z;
                    M0,30 C20,8 40,52 60,30 C80,8 100,52 120,30 C140,8 160,52 180,30 C200,8 220,52 240,30 L240,60 L0,60 Z
                  "
                />
              </path>
            </svg>

            {/* 中层波浪：反向滚动，更轻柔 */}
            <svg
              className="absolute left-0 w-[200%] h-[52%] animate-[ai-wave-scroll-b_3.6s_linear_infinite]"
              style={{
                bottom: "46%",
                filter: "blur(1.6px)",
                opacity: 0.7,
              }}
              viewBox="0 0 240 60"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="aiWaveB" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#bae6fd" stopOpacity="0.45" />
                  <stop offset="40%" stopColor="#38bdf8" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="#0284c7" stopOpacity="0.35" />
                </linearGradient>
              </defs>
              <path fill="url(#aiWaveB)">
                <animate
                  attributeName="d"
                  dur="1.4s"
                  repeatCount="indefinite"
                  calcMode="spline"
                  keySplines="0.45 0 0.55 1; 0.45 0 0.55 1"
                  keyTimes="0;0.5;1"
                  values="
                    M0,32 C15,6 35,54 55,28 C75,4 95,56 115,30 C135,6 155,54 175,28 C195,4 220,56 240,32 L240,60 L0,60 Z;
                    M0,28 C15,54 35,6 55,32 C75,56 95,4 115,30 C135,54 155,6 175,32 C195,56 220,4 240,28 L240,60 L0,60 Z;
                    M0,32 C15,6 35,54 55,28 C75,4 95,56 115,30 C135,6 155,54 175,28 C195,4 220,56 240,32 L240,60 L0,60 Z
                  "
                />
              </path>
            </svg>

            {/* 表层浪尖：仅顶部高光，向下快速淡出 */}
            <svg
              className="absolute left-0 w-[200%] h-[40%] animate-[ai-wave-scroll-c_2.2s_linear_infinite]"
              style={{
                bottom: "52%",
                filter: "blur(0.8px)",
                opacity: 0.55,
                mixBlendMode: "screen",
              }}
              viewBox="0 0 240 60"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="aiWaveC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.7" />
                  <stop offset="30%" stopColor="#7dd3fc" stopOpacity="0.35" />
                  <stop offset="70%" stopColor="#38bdf8" stopOpacity="0.08" />
                  <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path fill="url(#aiWaveC)">
                <animate
                  attributeName="d"
                  dur="1.1s"
                  repeatCount="indefinite"
                  calcMode="spline"
                  keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"
                  keyTimes="0;0.5;1"
                  values="
                    M0,34 C18,4 38,56 58,30 C78,2 98,58 118,32 C138,4 158,56 178,30 C198,2 222,58 240,34 L240,60 L0,60 Z;
                    M0,30 C18,56 38,4 58,34 C78,58 98,2 118,30 C138,56 158,4 178,34 C198,58 222,2 240,30 L240,60 L0,60 Z;
                    M0,34 C18,4 38,56 58,30 C78,2 98,58 118,32 C138,4 158,56 178,30 C198,2 222,58 240,34 L240,60 L0,60 Z
                  "
                />
              </path>
            </svg>

            {/* 整体纵向柔化罩：抹平层间色差 */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "linear-gradient(180deg, transparent 0%, rgba(14,165,233,0.12) 35%, rgba(2,132,199,0.2) 55%, transparent 78%)",
              }}
            />
          </div>

          {/* 气泡 */}
          <div
            className="absolute rounded-full bg-white/30 animate-[ai-bubble-1_3.2s_ease-in-out_infinite]"
            style={{ width: 4, height: 4, left: "30%", bottom: "20%" }}
          />
          <div
            className="absolute rounded-full bg-white/25 animate-[ai-bubble-2_4s_ease-in-out_infinite]"
            style={{ width: 3, height: 3, left: "55%", bottom: "16%" }}
          />
          <div
            className="absolute rounded-full bg-white/20 animate-[ai-bubble-3_4.8s_ease-in-out_infinite]"
            style={{ width: 5, height: 5, left: "42%", bottom: "10%" }}
          />
        </div>
      </div>

      {/* 玻璃顶部高光 */}
      <div
        className="absolute left-[12%] top-[8%] w-[42%] h-[28%] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 40% 30%, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.15) 45%, transparent 70%)",
          transform: "rotate(-16deg)",
        }}
      />

      <div
        className="absolute right-[10%] top-[30%] w-[10%] h-[28%] rounded-full pointer-events-none"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.25), transparent)",
          filter: "blur(1px)",
        }}
      />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-10">
        <span
          className="font-semibold tracking-wide text-white"
          style={{
            fontSize: Math.round(size * 0.32),
            letterSpacing: "0.06em",
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
            textShadow:
              "0 1px 2px rgba(0,0,0,0.55), 0 0 8px rgba(14,165,233,0.35)",
          }}
        >
          AI
        </span>
      </div>

      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.12), inset 0 -8px 16px rgba(2,132,199,0.12)",
        }}
      />

      <style>{`
        @keyframes ai-liquid-tumble {
          0%   { transform: rotate(-12deg) translateY(2%); }
          25%  { transform: rotate(9deg) translateY(-3%); }
          50%  { transform: rotate(14deg) translateY(1%); }
          75%  { transform: rotate(-7deg) translateY(-2%); }
          100% { transform: rotate(-12deg) translateY(2%); }
        }
        @keyframes ai-wave-scroll-a {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes ai-wave-scroll-b {
          from { transform: translateX(-50%); }
          to   { transform: translateX(0); }
        }
        @keyframes ai-wave-scroll-c {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes ai-bubble-1 {
          0%, 100% { transform: translate(0, 0); opacity: 0.15; }
          40% { transform: translate(6px, -16px); opacity: 0.5; }
          70% { transform: translate(-4px, -8px); opacity: 0.2; }
        }
        @keyframes ai-bubble-2 {
          0%, 100% { transform: translate(0, 0); opacity: 0.1; }
          50% { transform: translate(-8px, -18px); opacity: 0.4; }
        }
        @keyframes ai-bubble-3 {
          0%, 100% { transform: translate(0, 0); opacity: 0.12; }
          45% { transform: translate(10px, -14px); opacity: 0.35; }
        }
      `}</style>
    </div>
  )
}
