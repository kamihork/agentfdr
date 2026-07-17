<div align="center">
  <img src="https://raw.githubusercontent.com/kamihork/agentfdr/main/assets/logo.png" width="140" height="140" alt="agentfdr のロゴ — コーディングエージェントを追跡するレーダー">

  <h1>agentfdr</h1>

  <p><strong>ローカルコーディングエージェントのためのフライトデータレコーダー。</strong><br>
  Claude Code や Codex CLI がループした。ゴールから逸れた。気づけば200万トークンが溶けていた。<br><code>agentfdr</code> はその「なぜ」を、後からターン単位で解剖できるツールです。</p>

  <p>
    <a href="https://www.npmjs.com/package/agentfdr"><img src="https://img.shields.io/npm/v/agentfdr?color=f4511e&label=npm" alt="npm バージョン"></a>
    <a href="https://www.npmjs.com/package/agentfdr"><img src="https://img.shields.io/npm/dt/agentfdr?color=3987e5" alt="npm ダウンロード数"></a>
    <a href="https://github.com/kamihork/agentfdr/actions/workflows/test.yml"><img src="https://github.com/kamihork/agentfdr/actions/workflows/test.yml/badge.svg" alt="テストステータス"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/kamihork/agentfdr?color=199e70" alt="ライセンス"></a>
  </p>

  <p><a href="https://kamihork.github.io/agentfdr/">Website</a> | <a href="README.md">English</a> | 日本語</p>
</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kamihork/agentfdr/main/assets/screenshot-dark.png">
  <img alt="agentfdr タイムライン: 実際の200ターンセッション。異常フラグ、ツール/コンテキスト/出力レーン、ターン解剖パネル" src="https://raw.githubusercontent.com/kamihork/agentfdr/main/assets/screenshot-light.png">
</picture>

## クイックスタート

```sh
npx agentfdr
```

セットアップはこれだけです。Claude Code はすべてのセッションの完全な記録(transcript)を `~/.claude/projects/` に、OpenAI の Codex CLI はロールアウトを `~/.codex/sessions/` に書き出しています。`agentfdr` は両方を自動検出して、人間が調査できる形に変えます。

**計装ゼロ。クラウドゼロ。設定ゼロ。** データはどこにも送信されません。ビューアは `127.0.0.1` にのみバインドし、手元に既にあるファイルを読むだけです。

> agentfdr で自分のセッションについて何か発見があったら、⭐ を付けてもらえると他のエージェントユーザーに届きやすくなります。

## 機能

- 🛫 **タイムラインビューア** — セッション全体を1画面で: 各ターンのツール呼び出し・コンテキストウィンドウの構成・出力トークン、プロンプトと compaction のマーカー付き
- 🤝 **2つのエージェントを同じコックピットで** — Claude Code と OpenAI Codex CLI のセッションを自動検出し、同じタイムライン・検知器・検索・比較で調査
- 🔎 **全文検索** — `agentfdr search`(ビューアの**検索**タブも同じ)で全セッションのプロンプト・応答・ツール呼び出し・結果を横断検索し、該当ターンへジャンプ
- 🔍 **ターン解剖** — リサイズ可能なサイドパネルに usage 内訳・アシスタントの発言・各ツール呼び出しの所要時間/結果サイズ/スニペット。←/→ で移動
- 🚨 **異常検知** — ツールループ、エラー連続、コンテキスト肥大、トークン急増、キャッシュスラッシング、同一ファイル連続編集、refusal を自動で検知してフラグ付け
- 📡 **ライブウォッチ** — `agentfdr watch` で実行中セッションを自動追尾
- 📊 **プラン使用量** — 5時間ウィンドウ/日別/週間の消費を全プロジェクト横断で集計。直近12ヶ月のアクティビティヒートマップ、プラン種別の自動検出、予算設定で消費率を警告バー表示
- 💸 **コスト推定** — セッション別・モデル別の推定 USD(定価ベース)
- 🚦 **CI ゲート** — `agentfdr assert --no-loops --max-tokens 2M` が違反時に exit 1
- 📋 **Markdown 解剖レポート** — `agentfdr blame` の出力を issue にそのまま貼れる
- ⚖️ **セッション比較** — `agentfdr diff`(ビューアの**比較**タブも同じ)で、失敗した試行と成功した再試行を並べて表示。統計・異常・ツール構成・それぞれが触ったファイルの差分
- 🌗 **ダーク/ライト**、🌏 **日本語/英語**(ビューア・CLI とも)
- 🔒 **完全ローカル** — テレメトリなし、アカウント不要、ランタイム依存なし(Node ≥18 標準ライブラリのみ)

## なぜ必要か

自律エージェントの不具合は、気づいたときには証拠が流れてしまっていて、デバッグが困難です:

- *ループ* — 編集 → テスト失敗 → また同じ編集。それが40分続く
- *逸脱* — バグ修正を頼んだのに、ルーターをリファクタリングし始める
- *空費* — 巨大なツール結果がコンテキストを圧迫し、キャッシュが効かなくなり、毎ターン200kトークンを読み直す
- *不時着* — テストが落ちたまま「完了しました!」。あるいは、そもそも止まらない

既存の LLM オブザーバビリティツール(LangSmith、Langfuse、AgentOps)は、**自作アプリに SDK を組み込んでクラウドへトレースを送る**ことが前提です。Claude Code のような既製のローカルエージェントには、SDK を組み込む余地がありません。しかし、実はその必要もないのです。データはすでにディスクにあります。足りないのは事故調査官の道具箱だけ。それがこのツールです。

視野を広げると、エージェントとの開発は**ループエンジニアリング**へと変わりつつあります。モデルにプロンプトを投げて終わりではなく、エージェントループそのものを設計・運用する時代です。何をコンテキストに入れ、どのツールを実行し、いつ止めるかを決めるのは**ハーネス**(Claude Code などの実行系)。そのループを改善するには、まず観測が必要です。見えないループは、改善できません。agentfdr はループエンジニアリングの計器盤として、暴走や空費を「謎」ではなく「教訓」に変えます。

## コマンド

```
agentfdr                    # 最新セッションのタイムラインをブラウザで開く
agentfdr list               # 全プロジェクトの記録済みセッション一覧
agentfdr open 35cb18        # ID の先頭数文字(または .jsonl のパス)で開く
agentfdr watch              # 同上。ただしライブ — 実行中セッションを自動追尾
agentfdr blame 35cb18       # Markdown の解剖レポート — issue にそのまま貼れる
agentfdr diff 35cb18 9af7ec # 2セッションを比較: 失敗した試行 vs 成功した再試行
agentfdr search "ログインバグ"  # 全セッション横断の全文検索
agentfdr stats              # プロジェクトごとのトークン集計 + 推定コスト
agentfdr usage              # プラン使用量: 5時間ウィンドウ/日別/週の消費
agentfdr assert --no-loops --max-tokens 2M   # CI ゲート: 違反で exit 1
```

オプション: `--port <n>`(使用中なら自動で次のポートへ)、`--no-browser`、`--json`、`--lang en|ja`(`LANG` から自動判定)。

`assert` のチェック(自由に組み合わせ可、1つでも失敗すれば exit 1): `--no-loops`、`--no-critical`、`--max-errors <n>`、`--max-turns <n>`、`--max-tokens <n>`(新規入力+キャッシュ書込+出力。`500k` / `2M` 表記可)、`--max-cost <usd>`。

## ビューア

画面右に**解剖パネル**が常駐します(広い画面では常時表示、狭い画面ではスライドイン)。ターンをクリックすると内容が表示され、タイムラインが見えたまま **←/→** でターンを次々に調べられます(**Esc** で選択解除)。パネルの左端をドラッグすると幅を変更でき、設定は記憶されます。ターン未選択のあいだは**セッション概要**(よく使われたツールと編集回数の多いファイル)が表示されます。

メインビューはタブで切替: **タイムライン / テーブル表示 / プロンプト / 使用量 / 比較 / 検索**。プロンプトの行・異常チップ・検索結果をクリックすると、タイムラインの該当ターンへ自動でジャンプします。ヘッダーの絞り込みボックスで、全プロジェクト横断でセッション一覧を絞り込めます。凡例のツール色をクリックするとツールレーンを絞り込み。**レポートをコピー** で blame の Markdown をクリップボードへ、**● LIVE** で実行中セッションを自動更新(`agentfdr watch` なら最初からオン)。言語・テーマはヘッダーで切替でき、表示状態は URL で共有できます(`?theme=dark&tab=usage&sel=95`)。

**セッション情報** — ヘッダー行に、ターンを生成した全モデル(セッション途中でモデルを切り替えた場合はモデルごとのターン数付き)、fast モードのターン数、effort レベルを表示します。effort に関する注意: transcript の構造化フィールドには記録されていないため、`/effort` コマンドの出力から復元しています。セッション中に設定を変更した場合のみ表示されます。

**コスト推定** — 各セッション(および `stats` / `blame`)に、モデルごとの定価から算出した推定 USD を表示します(キャッシュ読取 ≈0.1×、書込 ≈1.25× で計算)。あくまで概算です: 割引・バッチ料金・価格改定は transcript からは分かりません。不明なモデルは除外してその旨を表示します。

![プラン使用量パネル: 5時間ウィンドウ、日別履歴、週合計、モデル別内訳](https://raw.githubusercontent.com/kamihork/agentfdr/main/assets/screenshot-usage-dark.png)

**プラン使用量** — `agentfdr usage`(ビューアの **使用量** パネルも同じ)は、全プロジェクトの transcript を、サブスクリプションの計測単位と同じ形に集計します: 現在の5時間ローリングウィンドウ、日別履歴、直近7日、モデル別内訳。プラン種別(例: `claude_max · default_claude_max_5x`)は Claude Code のローカル設定から自動取得します。正確なトークン上限は公開されていないため、予算は自分で設定する方式です(`--budget-5h` / `--budget-week`、環境変数 `AGENTFDR_BUDGET_5H` / `AGENTFDR_BUDGET_WEEK`、またはビューアの入力欄)。Claude Code の `/usage` 画面と一度見比べて値を調整すれば、以後は消費率が警告色付きのバーで表示されます。

## 異常フラグ

「まずどこを見るべきか」に答えるヒューリスティック:

| フラグ | 意味 |
|---|---|
| `loop` | 同一のツール呼び出しパターンが3回以上連続で反復 |
| `error-streak` | ツール呼び出しが3回以上連続で失敗 |
| `context-bloat` | 5万文字を超えるツール結果がコンテキストに流れ込んだ |
| `token-spike` | コンテキストが1ターンで60%超(+50k)急増 |
| `cache-thrash` | キャッシュヒットゼロのターンが連続 |
| `file-churn` | 同一ファイルを6回以上編集 |
| `refusal` | `stop_reason: refusal` で終了したターン(安全機構による拒否) |
| `stalled-call` | 結果が返らないままセッションが先へ進んだツール呼び出し |
| `api-error` | 失敗したツール結果に上流の API エラー(レート制限・過負荷・クォータ)が含まれる |
| `custom` | `.agentfdr.json` で定義した独自の正規表現ルール(下記参照) |

### 設定

すべての検知器は `.agentfdr.json` で調整できます(探索順: `--config <path>` → `./.agentfdr.json` → `~/.agentfdr.json`)。依存ゼロを守るため YAML ではなく JSON です。壊れた設定は必ずエラーになります — CI ゲートがルールの半分を黙って落としたまま動くことがあってはならないためです。

```json
{
  "thresholds": { "loopRepeats": 5, "contextBloatChars": 100000 },
  "disable": ["cache-thrash"],
  "suppressLoops": ["Bash:npm test", "Edit:*"],
  "custom": [
    { "name": "quota-masked", "match": "quota exceeded|monthly limit",
      "in": "tool-results", "severity": "critical" }
  ]
}
```

- `thresholds` — 各検知器の閾値を上書き(`loopRepeats`、`loopMinCalls`、`errorStreak`、`contextBloatChars`、`tokenSpikeTokens`、`tokenSpikeRatio`、`cacheThrashTurns`、`fileChurnEdits`)
- `suppressLoops` — 反復が正当なツールシグネチャ(テストのリトライ、ビルドのポーリングなど)。完全一致または `プレフィックス*`
- `disable` — 検知器ごと無効化
- `custom` — ツール結果やアシスタントの発言に対する独自の正規表現ルール(`in`: `tool-results` | `assistant-text` | `both`)。ビューア・blame レポート・`assert` に他のフラグと同格で現れます

## 仕組み

Claude Code はセッションの全イベント(ユーザープロンプト、トークン usage 付きのアシスタントメッセージ、ツール呼び出しと結果、compaction、モード変更)を `~/.claude/projects/<project>/<session-id>.jsonl` に追記しています。Codex CLI も同様に `~/.codex/sessions/YYYY/MM/DD/` へロールアウトファイルを書き出します。`agentfdr` はファイルごとにフォーマットを判別し、どちらも同じ正規化ターンモデルにパースして、同じ検知器を走らせます。デーモンなし、データベースなし、ランタイム依存なし(Node ≥18 標準ライブラリのみ)。

どちらの transcript フォーマットも公開 API ではないため、パーサーは「壊れないこと」を最優先に書かれています。未知の行タイプはメタイベントとして残し、壊れた行は数えてスキップ。各フォーマットの癖はそれぞれのアダプタモジュールに閉じ込めています。データの場所は `AGENTFDR_CLAUDE_DIR` / `AGENTFDR_CODEX_DIR` で上書きできます(プラン使用量は Claude サブスクリプションの計測なので Claude のみ対象です)。

## プライバシー

transcript にはあなたのコード・プロンプト・ファイルパスが含まれます。そのため:

- すべてローカルで完結。サーバーは `127.0.0.1` のみにバインド
- テレメトリなし、外部送信なし、アカウント不要
- `blame` の出力先は標準出力です。何をマシンの外に出すかは、あなたが決められます

## ロードマップ

- [x] ウォッチモード(`agentfdr watch`)によるライブタイムライン
- [x] CI ゲート — `agentfdr assert --no-loops --max-tokens 2M`
- [x] モデル別定価によるコスト推定
- [x] セッション比較 — 失敗した試行と成功した再試行の diff
- [x] 検知ルールのプラグイン化 — `.agentfdr.json` で閾値・除外・カスタム正規表現ルール
- [x] Codex CLI アダプタ — `~/.codex/sessions` のロールアウトを自動検出
- [ ] ループ検知の精度向上: 編集→テストの交互サイクルを作業として扱い、よくあるリトライ慣用句のデフォルト除外リストを同梱
- [ ] ループへの収束アノテーション(あくまでヒント表示、「安全宣言」にはしない)— 誤検知率が十分下がってから
- [ ] 意図ドリフト検知 — ツール/ファイルの操作範囲がプロンプトの依頼内容から逸れ始めたターンをフラグ
- [ ] 他エージェントのアダプタ(Gemini CLI、OpenHands、Aider)を同じ仕組みで追加
- [ ] サブエージェント/サイドチェーンのツリー表示

## 開発

```sh
git clone https://github.com/kamihork/agentfdr.git && cd agentfdr
npm test                 # テスト実行
node bin/agentfdr.js     # ソースから CLI を実行
```

`src/ui.html` はリクエストのたびに読み直されます。編集したらブラウザをリロードするだけで反映され、再起動は不要です。

コントリビューション歓迎です。特に他エージェントのアダプタと新しい検知ヒューリスティック。[CONTRIBUTING.md](CONTRIBUTING.md) をどうぞ。

## Star History

<a href="https://www.star-history.com/#kamihork/agentfdr&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=kamihork/agentfdr&type=Date&theme=dark">
    <img alt="Star History チャート" src="https://api.star-history.com/svg?repos=kamihork/agentfdr&type=Date">
  </picture>
</a>

## ライセンス

[MIT](LICENSE) © [kamihork](https://github.com/kamihork)
