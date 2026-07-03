# 10. Legacy Migration Notes

## 1. Current Repo Relationship

현재 `audio-musicfx-mcp` 저장소는 새 프로젝트의 코드 기반으로 직접 이어가기보다, **아이디어 검증과 sample target 소재**로 보는 것이 맞다.

새 프로젝트 목적:

```text
MCP Runtime Policy Gateway
```

기존 목적:

```text
CoreAudioFX / Android / Fleet / ADB 기반 제어 실험
```

두 방향은 제품 성격이 다르다. 새 프로젝트는 새 레포에서 시작한다.

## 2. Keep

| 자산 | 새 프로젝트에서의 역할 |
|---|---|
| [../PROJECT_DIRECTION.md](../PROJECT_DIRECTION.md) | 목적 정본 |
| 이전 feasibility report | optional reference snapshot, 정본 아님 |
| `apply_profile` / `bypass` / `rollback` 개념 | risky sample target tool |
| `dryRun` 개념 | limited alias demo |
| 기존 테스트 철학 | contract/integration/security regression 테스트 기준 |

## 3. Do Not Keep As Product Core

| 자산 | 이유 |
|---|---|
| Android app | 주력 제품이 아님 |
| ADB bridge | 제품 경로 아님 |
| Android Fleet Control Plane | 별도 운영 서버 제품으로 흐를 위험 |
| Web Dashboard mock-first UI | 새 Gateway MVP에는 후순위 |
| CoreAudioFX DSP | target fixture일 수는 있지만 제품 core가 아님 |
| Public Data 아이디어 | Skill/API wrapper 영역 |
| Browser/API/paywall 우회 수집 아이디어 | 약관, 라이선스, rate limit, anti-bot, 인증/권한 우회 위험 |

## 4. Suggested Sample Target Conversion

기존 CoreAudioFX 개념을 새 sample target으로 축소한다.

```text
sample-targets/risky-actions-mcp
  tools:
    audiofx.list_sessions       -> allow 후보
    audiofx.get_session_state   -> allow 후보
    audiofx.preview_profile     -> limited alias demo
    audiofx.apply_profile       -> approval required
    audiofx.bypass              -> approval required
    audiofx.rollback            -> approval required
```

주의:

- 실제 Android 연결은 구현하지 않는다.
- sample target은 in-memory fake로 충분하다.
- 목표는 오디오 효과가 아니라 Gateway 정책 집행을 증명하는 것이다.
- sample target은 paywall, 비공식 API, browser automation, rate-limit/anti-bot/인증 우회 사례를 포함하지 않는다.

## 5. Migration Risks

| Risk | Mitigation |
|---|---|
| Android 제품으로 다시 회귀 | 새 레포 README와 AGENTS에 non-goals 명시 |
| scanner-only로 축소 | runtime call enforcement 테스트를 MVP gate로 고정 |
| 보안 과장 | forbidden claims를 CI 문서 검사에 포함 |
| target 직접 등록 혼동 | deployment rule을 quickstart 첫 단계에 명시 |
| approval UX 과대 설계 | MVP는 CLI/manual approval store부터 시작 |

## 6. Final Handoff Statement

새 프로젝트는 기존 Android/AudioFX 프로젝트를 고도화하는 것이 아니다.

새 프로젝트는 **MCP server 사용 경로를 정책적으로 제한하고 감사하기 위한 runtime policy gateway**다. 기존 자산은 "위험 tool이 있는 target MCP"를 흉내 내는 데만 사용한다.
