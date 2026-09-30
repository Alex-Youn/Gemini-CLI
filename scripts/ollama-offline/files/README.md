# gemini-cli-ollama (폐쇄망용, Linux x86_64)

Gemini CLI v0.61.0 포크를 Ollama로 동작시키는 패키지입니다. 인터넷 없이
설치·실행합니다. Node 런타임이 들어 있어 서버에 Node를 따로 설치할 필요가
없습니다.

## 설치

```sh
tar -xzf gemini-cli-ollama-*-linux-x64.tar.gz
cd gemini-cli-ollama
sh install.sh
export PATH="$(pwd)/bin:$PATH"     # ~/.bashrc에도 추가
```

`install.sh`가 하는 일: 체크섬 확인, `runtime/node` 풀기, `config/gemini.env`
생성, `~/.gemini/settings.json`·`~/.gemini/GEMINI.md`(한국어 응답 지시)가 없으면
샘플 복사(있으면 그대로 둠).

## 설정

`config/gemini.env`에서 Ollama 주소와 모델을 확인합니다.

| 변수                     | 기본값                                |
| ------------------------ | ------------------------------------- |
| `GEMINI_OLLAMA_BASE_URL` | `http://127.0.0.1:11434`              |
| `GEMINI_OLLAMA_MODEL`    | `qwen3-coder:30b`                     |
| `GEMINI_OLLAMA_NUM_CTX`  | `32768` (SQL 튜닝 REST API와 같은 값) |

## 실행

```sh
cd <작업할 폴더>
gemini                          # 대화형 (처음에 폴더 신뢰 여부를 물음)
gemini -p "질문"                 # 한 번 실행 (폴더 신뢰 확인을 건너뛰려면 --skip-trust)
```

## 문제가 생기면

| 증상                                    | 확인                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `Ollama 서버(...)에 연결할 수 없습니다` | `curl $GEMINI_OLLAMA_BASE_URL/api/version`, `ollama serve` 기동 여부      |
| `모델 ...이(가) Ollama에 없습니다`      | `ollama list`에 `GEMINI_OLLAMA_MODEL`과 같은 이름이 있는지                |
| 인증 방식 선택 창이 뜸                  | `~/.gemini/settings.json`의 `security.auth.selectedType`이 `"ollama"`인지 |
