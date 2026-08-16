// ============================================================================
// Jenkinsfile — DeepSeek Harness Studio 桌面安装包 (Windows + macOS)
// ============================================================================
// 构建代理: 宿主机 macOS (Jenkins 节点 label = macos)
//   - macOS 安装包 (.dmg / .zip) 只能在 macOS 上构建
//   - Windows 安装包 (.exe: NSIS) 由 electron-builder 在 macOS 上交叉构建
//
// 适用仓库: https://github.com/WUYUPENGG/deepseek-harness-studio (fork 自
//           fufankeji/deepseek-harness-studio, 默认分支 main)
// 适配说明(相比旧项目 WUYUPENGG/deepseek-harness):
//   - 新项目 apps/desktop/package.json 的 mac.notarize 写死为 true,
//     不签名构建必须用 CLI 覆盖 --config.mac.notarize=false
//   - 签名 macOS 构建走上游 release-preflight.ts 的失败即报错 (fail-loud) 校验,
//     需要 CSC_NAME 凭据 (旧项目没有); 详见 接入指南-签名.md
//   - stage-runtime.ts 用 DSH_DESKTOP_TARGET_PLATFORM / DSH_DESKTOP_TARGET_ARCH
//     指定打包目标平台 (macOS: darwin/arm64, Windows: win32/x64)
//   - Windows 交叉构建用 release-win.ts (内部处理 NSIS 260 字符路径限制)
//
// 用法:
//   - TARGETS: all = macOS + Windows; mac = 仅 macOS; win = 仅 Windows
//   - MAC_ARCH: macOS 目标架构, 默认 arm64 (Apple Silicon); 需要 Intel 时选 x64
//   - 首次构建较慢 (pnpm install + 双平台 Electron 二进制下载), 后续走缓存
// ============================================================================

pipeline {
    agent { label 'macos' }

    options {
        timestamps()
        timeout(time: 180, unit: 'MINUTES')
        disableConcurrentBuilds()   // 共享 workspace 与 electron-builder 缓存，禁止并发
    }

    parameters {
        choice(
            name: 'TARGETS',
            choices: ['all', 'mac', 'win'],
            description: '要构建的安装包：all = macOS + Windows，mac = 仅 macOS，win = 仅 Windows'
        )
        string(
            name: 'BRANCH',
            defaultValue: 'main',
            description: '要构建的分支'
        )
        choice(
            name: 'MAC_ARCH',
            choices: ['arm64', 'x64'],
            description: 'macOS 目标架构（宿主机 arm64 时默认 arm64；Intel Mac 构建 x64）'
        )
        booleanParam(
            name: 'SKIP_BUILD',
            defaultValue: false,
            description: '跳过 workspace 构建（复用工作区已有的 lib/dist 产物，用于重试打包阶段）'
        )
        booleanParam(
            name: 'SIGN',
            defaultValue: false,
            description: '使用 Jenkins 凭据对安装包签名（macOS: Developer ID 签名 + 公证；Windows: Authenticode）。凭据配置见 接入指南-签名.md'
        )
    }

    environment {
        // agent 的 SSH 非交互 shell 不加载 nvm/用户 profile，手动把 Node 24 + pnpm 的 bin 加进 PATH
        PATH = "${env.PATH}:/Users/wuyupeng/.nvm/versions/node/v24.15.0/bin"
        // 中国大陆网络下直连 GitHub 下载 Electron/NSIS 易超时，默认走 npmmirror 镜像；
        // 网络通畅时删除这两行可回落到官方源
        ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
        // electron-builder 下载缓存放 agent 主目录，跨构建复用
        ELECTRON_BUILDER_CACHE = "${env.HOME}/.cache/electron-builder"
        // 打包目标平台/架构（stage-runtime.ts 读取）
        DSH_DESKTOP_TARGET_PLATFORM = ''
        DSH_DESKTOP_TARGET_ARCH = ''
    }

    stages {
        stage('检出代码') {
            steps {
                checkout scm
                sh "git checkout ${params.BRANCH} || true"
                sh 'git rev-parse --short HEAD'
            }
        }

        stage('环境检查') {
            steps {
                sh '''
                    set -e
                    echo "node: $(node --version)"
                    echo "git: $(git --version)"
                    corepack enable || true
                    pnpm --version || { echo "未找到 pnpm，请先安装：npm i -g pnpm@11.7.0"; exit 1; }
                '''
            }
        }

        stage('安装依赖') {
            steps {
                // 注意: 首次安装较大 (pnpm-lock.yaml ~780KB, workspace 几十个包)
                sh 'pnpm install --frozen-lockfile'
            }
        }

        stage('构建 dsh workspace') {
            when { expression { !params.SKIP_BUILD } }
            steps {
                // = build:lib + build:web + build:desktop (tsc + tsdown + 前端产物)
                sh 'pnpm run build'
            }
        }

        stage('macOS 安装包 (.dmg/.zip)') {
            when { expression { params.TARGETS == 'all' || params.TARGETS == 'mac' } }
            steps {
                // 1) 暂存 macOS (darwin/arm64 或 x64) Host 运行时
                withEnv(["MAC_ARCH=${params.MAC_ARCH}"]) {
                    sh '''
                        set -e
                        cd apps/desktop
                        DSH_DESKTOP_TARGET_PLATFORM=darwin DSH_DESKTOP_TARGET_ARCH=${MAC_ARCH} node --import tsx scripts/stage-runtime.ts
                    '''
                    // 2) 打包 .dmg/.zip
                    script {
                        if (params.SIGN) {
                            withCredentials([
                                string(credentialsId: 'macos-csc-b64', variable: 'CSC_LINK'),
                                string(credentialsId: 'macos-csc-password', variable: 'CSC_KEY_PASSWORD'),
                                string(credentialsId: 'macos-csc-name', variable: 'CSC_NAME'),
                                string(credentialsId: 'apple-api-key', variable: 'APPLE_API_KEY'),
                                string(credentialsId: 'apple-api-key-id', variable: 'APPLE_API_KEY_ID'),
                                string(credentialsId: 'apple-api-issuer', variable: 'APPLE_API_ISSUER'),
                                string(credentialsId: 'apple-team-id', variable: 'APPLE_TEAM_ID')
                            ]) {
                                // 上游 fail-loud 预检：缺证书/公证凭据时直接失败，避免"看似成功实则未签名"
                                sh '''
                                    set -e
                                    cd apps/desktop
                                    node --import tsx scripts/release-preflight.ts
                                    pnpm exec electron-builder --mac dmg zip --${MAC_ARCH} --config.forceCodeSigning=true --config.mac.notarize=true
                                '''
                            }
                        } else {
                            // 不签名：必须显式覆盖 package.json 里写死的 mac.notarize=true
                            sh '''
                                set -e
                                cd apps/desktop
                                CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dmg zip --${MAC_ARCH} --config.mac.notarize=false
                            '''
                        }
                    }
                }
                archiveArtifacts artifacts: 'apps/desktop/dist/*.dmg,apps/desktop/dist/*.zip,apps/desktop/dist/*.blockmap', fingerprint: true, allowEmptyArchive: true
            }
        }

        stage('Windows 安装包 (.exe NSIS)') {
            when { expression { params.TARGETS == 'all' || params.TARGETS == 'win' } }
            steps {
                // 1) 暂存 win32/x64 Host 运行时
                sh '''
                    set -e
                    cd apps/desktop
                    DSH_DESKTOP_TARGET_PLATFORM=win32 DSH_DESKTOP_TARGET_ARCH=x64 node --import tsx scripts/stage-runtime.ts
                '''
                // 2) 打包 NSIS (release-win.ts 内部处理 macOS 交叉构建的路径/签名)
                script {
                    if (params.SIGN) {
                        withCredentials([
                            string(credentialsId: 'win-csc-b64', variable: 'WIN_CSC_LINK'),
                            string(credentialsId: 'win-csc-password', variable: 'WIN_CSC_KEY_PASSWORD')
                        ]) {
                            sh 'cd apps/desktop && node --import tsx scripts/release-win.ts'
                        }
                    } else {
                        sh 'cd apps/desktop && node --import tsx scripts/release-win.ts'
                    }
                }
                archiveArtifacts artifacts: 'apps/desktop/dist/*.exe,apps/desktop/dist/*.blockmap', fingerprint: true, allowEmptyArchive: true
            }
        }

        stage('产物清单') {
            steps {
                sh '''
                    set -e
                    echo "=== 安装包清单 ==="
                    ls -lh apps/desktop/dist/ || true
                    shasum -a 256 apps/desktop/dist/*.dmg apps/desktop/dist/*.zip apps/desktop/dist/*.exe 2>/dev/null || true
                '''
            }
        }
    }

    post {
        success {
            echo '构建成功：安装包已归档到本次构建的 Artifacts 中。'
        }
        failure {
            echo '构建失败：请查看控制台日志；常见问题见 outputs/deepseek-harness-studio-jenkins/接入指南.md。'
        }
    }
}
