# Managed Client Deployment

이 문서는 MCP Runtime Policy Gateway를 실제 사용자 환경에 배포할 때 target MCP 직접 등록 우회를 줄이기 위한 운영 체크리스트다.

핵심 원칙:

- client config에는 Gateway만 배포한다.
- target MCP command/url/token은 사용자 client config에 두지 않는다.
- target 등록은 Gateway registry 또는 trusted operator 승인 경로로만 수행한다.
- 사용자가 client config를 자유롭게 수정할 수 있으면 strong enforcement claim을 하지 않는다.
- `config:validate`는 drift detection이며 OS-level lock이 아니다.

## Deployment Modes

| Mode | 설명 | 가능한 주장 |
|---|---|---|
| `self-managed` | 사용자가 README 예시를 보고 직접 설정한다. | Gateway 사용 흐름을 안내할 수 있다. 사용자가 target을 직접 추가하면 우회 가능하다. |
| `validated-local` | `config:validate`로 현재 client config가 Gateway-only인지 확인한다. | 검사 시점의 direct target 등록 drift를 감지할 수 있다. 설정 변경 자체를 막지는 않는다. |
| `managed-enforced` | 조직이 MDM, GPO, read-only config, workspace policy 또는 동등한 통제로 client config를 배포하고 임의 수정을 제한한다. | target MCP가 Gateway 뒤에 있다는 조건에서 강한 Gateway-only enforcement claim을 할 수 있다. |

## Operator Checklist

- [ ] 사용자의 MCP client config에는 `mcp-policy-gateway`만 등록한다.
- [ ] target MCP command/url/token은 Gateway 운영 환경이나 승인된 secret/profile 저장소에만 둔다.
- [ ] target MCP 등록은 Gateway operator workflow에서 검토한다.
- [ ] PlayMCP 또는 unknown MCP preflight 결과를 target 등록 전 검토한다.
- [ ] 등록 후 Gateway의 filtered alias surface와 approval policy를 확인한다.
- [ ] 사용자가 임의 MCP server를 추가할 수 있는 self-managed 환경이면 strong enforcement claim을 하지 않는다.
- [ ] managed-enforced 환경에서는 config 배포/잠금 방식과 예외 승인 절차를 운영 문서에 남긴다.

## Local Validation

Gateway-only config 예시를 생성한 뒤 검사한다.

```bash
npm run --silent config:client -- claude-desktop > /tmp/mcp-policy-gateway-claude.json
npm run config:validate -- claude-desktop /tmp/mcp-policy-gateway-claude.json
```

실제 사용자 config 파일도 같은 방식으로 검사한다.

```bash
npm run config:validate -- claude-desktop /path/to/claude_desktop_config.json
npm run config:validate -- codex-cli /path/to/codex-config.toml
npm run config:validate -- generic-json /path/to/mcp-config.json
```

검사 결과가 `PASS`면 해당 파일의 MCP server 목록은 Gateway-only 상태다. `FAIL`이면 직접 등록된 MCP server 이름을 확인하고 제거한 뒤 다시 검사한다.

## What This Does Not Do

- 사용자 PC의 파일 권한을 잠그지 않는다.
- Claude, Codex CLI, desktop MCP client 내부 설정 UI를 비활성화하지 않는다.
- 사용자가 나중에 설정 파일을 다시 수정하는 행동을 막지 않는다.
- 모든 MCP client를 자동으로 보호하지 않는다.
- target MCP 자체의 모든 동작을 안전하다고 보장하지 않는다.

이 문서의 범위는 Gateway-only client config를 배포/검증하는 운영 모델이다. 강한 직접 연결 차단은 managed-enforced 환경의 외부 배포 통제와 함께 주장해야 한다.
