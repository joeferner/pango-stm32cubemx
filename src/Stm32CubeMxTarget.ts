import {ProjectOptions, Shell, Target, Targets} from "pango";
import {getStm32CubeMxOptions, Stm32CubeMxOptions} from "./Stm32CubeMxOptions";
import * as path from "path";
import * as fs from "fs-extra";
import * as ejs from "ejs";
import * as glob from "glob-promise";
import {MakefileParser} from "./MakefileParser";

export class Stm32CubeMxTarget implements Target {
    helpMessage = 'Generate source files from STM32CubeMX .ioc project';
    preRequisites: ['initialize'];
    postRequisites = ['generate-sources'];

    async run(projectOptions: ProjectOptions): Promise<void | Targets | string[]> {
        const options = getStm32CubeMxOptions(projectOptions);
        const genDir: string = path.join(projectOptions.buildDir, 'stm32cubemx', 'gen');
        const outputIocFile = path.join(genDir, 'stm32cubemx.ioc');
        const touchFile = path.join(genDir, 'stm32cubemxgen');
        const stm32CubeMxExecutableFile = options.stm32cubemx;
        const inputIocFile = await this.getInputIocFile(projectOptions, options);
        projectOptions.logger.info(`processing ioc file: ${inputIocFile}`);
        const changed = await this.hasIocChanged(inputIocFile, touchFile);
        if (changed) {
            if (fs.pathExists(genDir)) {
                projectOptions.logger.info(`Deleting old directory ${path.resolve(genDir)}`);
                await fs.remove(path.resolve(genDir));
            }
            await fs.mkdirs(genDir);

            const scriptFile = await this.writeScriptTemplate(genDir);
            await fs.copy(inputIocFile, outputIocFile);
            await this.runSTM32CubeMX(projectOptions, stm32CubeMxExecutableFile, genDir, scriptFile);
            await this.patchFiles(projectOptions, options, genDir);
            await this.writeTouchFile(touchFile);
        }
        return this.addInfoFromMakefile(projectOptions, genDir);
    }

    private async writeTouchFile(touchFile: string): Promise<void> {
        fs.writeFile(touchFile, new Date().toString());
    }

    private async runSTM32CubeMX(
        projectOptions: ProjectOptions,
        stm32CubeMxExecutableFile: string,
        genDir: string,
        scriptFile: string
    ): Promise<void> {
        return Shell.shell(projectOptions, [stm32CubeMxExecutableFile, '-q', scriptFile], {
            cwd: genDir
        });
    }

    private async writeScriptTemplate(genDir: string) {
        const templateFile = path.join(__dirname, '../src/stm32cubemx-gen.script.ejs');
        const content = await fs.readFile(templateFile, 'utf8');
        const template = ejs.compile(content);
        const renderedContent = template({
            dir: path.resolve(genDir)
        });
        const fileName = path.resolve(genDir, 'stm32cubemx.script');
        await fs.writeFile(fileName, renderedContent);
        return fileName;
    }

    private async getInputIocFile(projectOptions: ProjectOptions, options: Stm32CubeMxOptions): Promise<string> {
        const inputIocFile = options.iocFile;
        if (inputIocFile) {
            return inputIocFile;
        }
        let projectDir = projectOptions.projectDir;
        let results = await glob('**/*.ioc', {
            cwd: projectDir,
            follow: true,
            ignore: [
                'node_modules/**',
                path.relative(projectDir, path.join(projectOptions.buildDir, '**'))
            ]
        });
        results = results.filter(r => {
            return !r.startsWith(projectOptions.buildDir);
        });
        if (results.length === 0) {
            throw new Error('Could not find .ioc file in project directories');
        }
        if (results.length > 1) {
            throw new Error(`Found too many .ioc file in project directories ${results}`);
        }
        return path.join(projectDir, results[0]);
    }

    private async hasIocChanged(inputIocFile: any, touchFile: string): Promise<boolean> {
        try {
            const inputIocFileStats = (await fs.stat(inputIocFile)).mtimeMs;
            const outputIocFileStats = (await fs.stat(touchFile)).mtimeMs;
            return inputIocFileStats > outputIocFileStats;
        } catch (err) {
            return true;
        }
    }

    private async patchFiles(projectOptions: ProjectOptions, options: Stm32CubeMxOptions, genDir: string): Promise<void> {
        await this.patchMainC(projectOptions, genDir);
        await this.patchHFiles(options, genDir);
    }

    private async patchMainC(projectOptions: ProjectOptions, genDir: string) {
        await Shell.shell(projectOptions, ['dos2unix', path.resolve(genDir, 'Src/main.c')]);
        return Shell.shell(projectOptions, ['patch', '-N', path.resolve(genDir, 'Src/main.c'), path.resolve(__dirname, '../src/stm32cubemx-gen.patch')]);
    }

    private async patchHFiles(options: Stm32CubeMxOptions, genDir: string) {
        let cwd = path.resolve(genDir, 'Drivers/CMSIS/Device/ST');
        const hFiles = await glob('**/*.h', {cwd: cwd, follow: true})
        return Promise.all(hFiles.map(hFile => {
            return this.patchHFile(options, path.resolve(cwd, hFile));
        }));
    }

    private async patchHFile(options: Stm32CubeMxOptions, hFile: string) {
        const flashStart = options.flashStart || 0x08000000;
        const eePromStart = options.eePromStart || 0x08080000;
        let contents: string = await fs.readFile(hFile, 'utf8')
        contents = contents.replace(/^#define(\s+?)FLASH_BASE\s+.*$/gm, `#define FLASH_BASE ((uint32_t)0x${flashStart.toString(16)})`);
        contents = contents.replace(/^#define(\s+?)DATA_EEPROM_BASE\s+.*$/gm, `#define DATA_EEPROM_BASE ((uint32_t)0x${eePromStart.toString(16)})`);
        return fs.writeFile(hFile, contents);
    }

    private async addInfoFromMakefile(
        projectOptions: ProjectOptions,
        genDir: string
    ): Promise<void> {
        const sourceFiles = new Set();
        const includeDirs = new Set();
        const compilerOptions = new Set();
        const linkerOptions = new Set();
        const makefile = path.resolve(genDir, 'Makefile');
        let ldFile;
        const makefileContent = await fs.readFile(makefile, 'utf8');
        const vars = MakefileParser.parse(makefileContent);
        addAllToSet(sourceFiles, MakefileParser.stringToArray(vars['C_SOURCES']));
        addAllToSet(sourceFiles, MakefileParser.stringToArray(vars['ASM_SOURCES']));
        addAllToSet(
            includeDirs,
            MakefileParser.stringToArray(vars['C_INCLUDES'])
                .map(i => i.substr('-I'.length))
                .map(i => path.resolve(genDir, i))
        );
        addAllToSet(compilerOptions, MakefileParser.stringToArray(vars['C_DEFS']));
        addAllToSet(compilerOptions, MakefileParser.stringToArray(MakefileParser.resolve(vars, vars['MCU'])));
        addAllToSet(
            linkerOptions,
            MakefileParser.stringToArray(MakefileParser.resolve(vars, vars['LDFLAGS']))
                .map(f => {
                    const m = f.trim().match(/^-T(.*?\.ld)$/);
                    if (m) {
                        ldFile = path.join(genDir, m[1]);
                        f = `-T${ldFile}`
                    }
                    return f;
                })
                .filter(f => {
                    // TODO refactor to user config
                    if (f === '-lnosys') {
                        return false;
                    }
                    return true;
                })
        );

        projectOptions.sourceFiles = projectOptions.sourceFiles || [];
        projectOptions.sourceFiles.push(
            ...Array.from(sourceFiles)
                .map(sourceFile => {
                    const filePathWithoutExt = path.basename(sourceFile, path.extname(sourceFile));
                    return {
                        fileName: path.resolve(genDir, sourceFile),
                        outputPath: path.join(projectOptions.buildDir, 'stm32cubemx', filePathWithoutExt) + '.o',
                        depPath: path.join(projectOptions.buildDir, 'stm32cubemx', filePathWithoutExt) + '.d',
                    };
                })
        );

        projectOptions.includeDirs = projectOptions.includeDirs || [];
        projectOptions.includeDirs.push(...Array.from(includeDirs));

        projectOptions.compilerOptions = projectOptions.compilerOptions || [];
        projectOptions.compilerOptions.push(...Array.from(compilerOptions));

        projectOptions.linkerOptions = projectOptions.linkerOptions || [];
        projectOptions.linkerOptions.push(...Array.from(linkerOptions));

        if (ldFile) {
            // TODO patch ld file with flash start, ram start, and eeprom start values
            // LINK_FLASH_START       ?= 0x08000000
            // LINK_RAM_START         ?= 0x20000000
            // LINK_DATA_EEPROM_START ?= 0x08080000
            // MEMORY
            // {
            //     FLASH (rx)      : ORIGIN = $(LINK_FLASH_START), LENGTH = $(LINK_FLASH_LENGTH)
            //     RAM (xrw)       : ORIGIN = $(LINK_RAM_START), LENGTH = $(LINK_RAM_LENGTH)
            // }
            const ldFileContents = await fs.readFile(ldFile, 'utf8');
            let m = ldFileContents.match(/^RAM.*LENGTH = (.*?)K$/m);
            if (m) {
                projectOptions.ram = parseInt(m[1]) * 1024;
            }

            m = ldFileContents.match(/^FLASH.*LENGTH = (.*?)K$/m);
            if (m) {
                projectOptions.flash = parseInt(m[1]) * 1024;
            }
        }
    }
}

function addAllToSet(set: Set<any>, values: string[]) {
    for (const value of values) {
        set.add(value);
    }
}
