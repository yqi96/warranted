# Benchmark assets

Downloaded on 2026-08-31 for the evaluation plan in
[`paper-evaluation-report.zh-CN.md`](paper-evaluation-report.zh-CN.md).

The downloaded third-party assets are intentionally ignored by Git. Exact source
revisions, download URLs, local layout, licenses, and SHA-256 checksums are kept
here so that another machine can reproduce the same workspace.

## Local layout

```text
experiments/
  benchmarks/
    scifact/
      source/                 # pinned official code snapshot
      data/                   # extracted official data.tar.gz
    vitaminc/
      source/                 # pinned official code snapshot
      data/                   # extracted fact verification/flagging/rationale data
    deepfact/
      source/                 # pinned official code snapshot
      data/                   # pinned Hugging Face dataset files
    scienceagentbench/
      source/                 # pinned official code snapshot
      data/                   # pinned HF annotations and verified split
      artifacts/
        benchmark_verified.zip  # official password-protected full benchmark
  downloads/                  # retained source/data archives
  papers/                     # formal proceedings PDFs
  benchmark-assets.sha256
```

## Versions and provenance

| Benchmark | Code revision | Data revision/source | Paper |
|---|---|---|---|
| SciFact | `allenai/scifact@68b98a56d93e0f9da0d2aab4e6c3294699a0f72e` | [AI2 S3 release archive](https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz), downloaded 2026-08-31 | [EMNLP 2020](https://aclanthology.org/2020.emnlp-main.609.pdf) |
| VitaminC | `TalSchuster/VitaminC@eb532922b88b199df68ed26afeb58dca5501b52f` | `TalSchuster/talschuster.github.io@152c9639f1e33ca295d0776b618c17884088f72f`; `vitaminc`, `real`, `synthetic`, `flagging`, and `rationale` archives | [NAACL 2021](https://aclanthology.org/2021.naacl-main.52.pdf) |
| DeepFactBench | `kkkevinkkkkk/DeepFact@9f519f172f32b658fd694efd8e15210f04c33b64` | `kkkevinkkk/DeepFactBench@55975dffbe41a81723da64e020d7df879ee18b57` | [ACL 2026](https://aclanthology.org/2026.acl-long.1586.pdf) |
| ScienceAgentBench | `OSU-NLP-Group/ScienceAgentBench@c26e151ed601ba109dc4d35e057ff8e73fec469d` | `osunlp/ScienceAgentBench@9c6e96c9e74572e979b0930ee735041cef528cb7`; official `benchmark_verified.zip` from the repository README | [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/file/f12b4df26344f3be803c06b555252efe-Paper-Conference.pdf) |

## Downloaded data summary

- **SciFact:** 5,183 corpus abstracts; 809 train, 300 dev, and 300 unlabeled
  test claims, plus five cross-validation folds. Official test labels remain
  private and require leaderboard evaluation.
- **VitaminC:** 370,653/63,054/55,197 fact-verification train/dev/test rows;
  revision flagging and rationale datasets are also present. `vitaminc_real` and
  `vitaminc_synthetic` test sets are retained separately.
- **DeepFactBench:** `test.json` contains 621 claims and `test_reports.json`
  contains 15 reports.
- **ScienceAgentBench:** the pinned HF verified annotation Parquet is present,
  together with the legacy CSV and dataset card. The full official encrypted
  archive is 1,769,478,786 bytes and passed `unzip -t` with the public password
  given in the upstream README. It remains unextracted to reduce benchmark
  contamination.

## Licensing and handling notes

- SciFact code is Apache-2.0. Its annotations are CC BY 4.0; the S2ORC abstract
  corpus uses ODC-By 1.0.
- VitaminC code is MIT. Its data inherits the applicable Wikipedia and FEVER
  attribution/share-alike terms; see `benchmarks/vitaminc/source/DATA_LICENSE`.
- DeepFact code and the Hugging Face dataset card declare MIT.
- ScienceAgentBench code is MIT and its Hugging Face benchmark card declares
  CC BY 4.0, with original licenses retained for the rasterio/matminer-derived
  tasks. The authors explicitly request that **unzipped benchmark data not be
  redistributed online**. Do not commit or re-host the full archive or any
  extracted files.

## Verification

From the repository root:

```bash
sha256sum -c experiments/benchmark-assets.sha256
unzip -P scienceagentbench -tq \
  experiments/benchmarks/scienceagentbench/artifacts/benchmark_verified.zip
```

No benchmark model weights or runtime dependencies were downloaded or installed.
