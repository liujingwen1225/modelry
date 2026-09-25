package extensions

import (
	"errors"
	"unicode/utf8"

	"github.com/evanw/esbuild/pkg/api"
)

const maximumSourceBytes = 256 << 10

var errInvalidSource = errors.New("extension source is invalid")

type Language string

const (
	LanguageJavaScript Language = "javascript"
	LanguageTypeScript Language = "typescript"
)

// CompileSource 校验并转换一个独立 Extension 源文件。
func CompileSource(language Language, source string) (string, error) {
	if !utf8.ValidString(source) || len([]byte(source)) == 0 || len([]byte(source)) > maximumSourceBytes {
		return "", errInvalidSource
	}
	loader := api.LoaderJS
	switch language {
	case LanguageJavaScript:
	case LanguageTypeScript:
		loader = api.LoaderTS
	default:
		return "", errInvalidSource
	}
	result := api.Build(api.BuildOptions{
		Bundle:        true,
		Write:         false,
		Stdin:         &api.StdinOptions{Contents: source, Sourcefile: "extension.js", Loader: loader},
		Format:        api.FormatIIFE,
		GlobalName:    "ModelryExtension",
		Target:        api.ES2022,
		Platform:      api.PlatformNeutral,
		LegalComments: api.LegalCommentsNone,
		LogLevel:      api.LogLevelSilent,
		Plugins: []api.Plugin{{
			Name: "reject-extension-imports",
			Setup: func(build api.PluginBuild) {
				build.OnResolve(api.OnResolveOptions{Filter: ".*"}, func(args api.OnResolveArgs) (api.OnResolveResult, error) {
					return api.OnResolveResult{Errors: []api.Message{{Text: "module imports are not supported"}}}, nil
				})
			},
		}},
	})
	if len(result.Errors) != 0 || len(result.OutputFiles) != 1 || len(result.OutputFiles[0].Contents) == 0 || len(result.OutputFiles[0].Contents) > maximumSourceBytes {
		return "", errInvalidSource
	}
	return string(result.OutputFiles[0].Contents), nil
}
