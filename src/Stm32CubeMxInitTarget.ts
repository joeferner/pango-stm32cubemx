import {ProjectOptions, Target, Targets} from "pango";

export class Stm32CubeMxInitTarget implements Target {
    helpMessage = 'Initializes project options for use with STM32CubeMX';
    preRequisites: ['initialize'];
    postRequisites = ['stm32cubemx'];

    async run(projectOptions: ProjectOptions): Promise<void | Targets | string[]> {
        projectOptions.stm32cubemx = projectOptions.stm32cubemx || {};
        projectOptions.stm32cubemx.ldFileFilters = projectOptions.stm32cubemx.ldFileFilters || [];
        return Promise.resolve();
    }
}
